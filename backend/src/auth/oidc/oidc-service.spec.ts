/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AuthProviderType } from '@hedgedoc/commons';
import { FieldNameIdentity, Identity } from '@hedgedoc/database';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Mock } from 'ts-mockery';
import * as jose from 'jose';
import type { JWTPayload } from 'jose';

import type { RequestWithSession } from '../../api/utils/request.type';
import appConfiguration from '../../config/app.config';
import authConfiguration from '../../config/auth.config';
import { GroupsService } from '../../groups/groups.service';
import { ConsoleLoggerService } from '../../logger/console-logger.service';
import { SessionService } from '../../sessions/session.service';
import { IdentityService } from '../identity.service';
import { OidcService } from './oidc.service';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

describe('OidcService', () => {
  let oidcService: OidcService;
  let identityService: IdentityService;
  let sessionService: SessionService;
  let groupsService: GroupsService;
  let logger: ConsoleLoggerService;

  const mockOidcConfig = {
    identifier: 'test-oidc',
    providerName: 'Test OIDC',
    issuer: 'https://oidc.example.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scope: 'openid profile email',
  };

  const mockAppConfig = {
    baseUrl: 'http://localhost:3000',
  };

  const mockAuthConfig = {
    oidc: [],
  };

  const mockIssuer = {
    metadata: {
      issuer: 'https://oidc.example.com',
      jwks_uri: 'https://oidc.example.com/.well-known/jwks.json',
    },
  };

  const mockClient = {
    metadata: {
      client_id: 'test-client-id',
    },
  };

  beforeEach(async () => {
    const testModule: TestingModule = await Test.createTestingModule({
      providers: [
        OidcService,
        {
          provide: IdentityService,
          useValue: Mock.of<IdentityService>({
            getIdentityFromUserIdAndProviderType: jest.fn(),
          }),
        },
        {
          provide: SessionService,
          useValue: Mock.of<SessionService>({
            terminateSessionByOidcSid: jest.fn<typeof sessionService.terminateSessionByOidcSid>(),
            terminateAllSessionsOfUser: jest.fn<typeof sessionService.terminateAllSessionsOfUser>(),
          }),
        },
        {
          provide: GroupsService,
          useValue: Mock.of<GroupsService>({
            syncGroupMemberships: jest.fn(() => Promise.resolve()),
          }),
        },
        {
          provide: ConsoleLoggerService,
          useValue: Mock.of<ConsoleLoggerService>({
            setContext: jest.fn(),
            debug: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
          }),
        },
        {
          provide: authConfiguration.KEY,
          useValue: mockAuthConfig,
        },
        {
          provide: appConfiguration.KEY,
          useValue: mockAppConfig,
        },
      ],
    }).compile();

    oidcService = testModule.get<OidcService>(OidcService);
    identityService = testModule.get<IdentityService>(IdentityService);
    sessionService = testModule.get<SessionService>(SessionService);
    groupsService = testModule.get<GroupsService>(GroupsService);
    logger = testModule.get<ConsoleLoggerService>(ConsoleLoggerService);

    // Manually set up the client config to bypass the initialization
    (oidcService as any).clientConfigs.set(mockOidcConfig.identifier, {
      client: mockClient,
      issuer: mockIssuer,
      redirectUri: `http://localhost:3000/api/private/auth/oidc/${mockOidcConfig.identifier}/callback`,
      config: mockOidcConfig,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const setClientConfig = (config: Record<string, unknown>, client: object = mockClient) => {
    (oidcService as any).clientConfigs.set(mockOidcConfig.identifier, {
      client,
      issuer: mockIssuer,
      redirectUri: `http://localhost:3000/api/private/auth/oidc/${mockOidcConfig.identifier}/callback`,
      config: { ...mockOidcConfig, ...config },
    });
  };

  describe('extractUserInfoFromCallback', () => {
    const extractWithUserinfo = async (
      userinfo: Record<string, unknown>,
      config: Record<string, unknown>,
    ): Promise<RequestWithSession> => {
      setClientConfig(config, {
        ...mockClient,
        callbackParams: jest.fn(() => ({})),
        callback: jest.fn(() => Promise.resolve({})),
        userinfo: jest.fn(() =>
          Promise.resolve({ sub: 'carol-id', preferred_username: 'carol', ...userinfo }),
        ),
      });
      const request = Mock.of<RequestWithSession>({
        raw: {} as RequestWithSession['raw'],
        session: {
          oidc: { idToken: null, sid: null, loginCode: 'code', loginState: 'state' },
          pendingUser: null,
        } as unknown as RequestWithSession['session'],
      });
      await oidcService.extractUserInfoFromCallback(mockOidcConfig.identifier, request);
      return request;
    };
    const fieldConfig = {
      userIdField: 'sub',
      usernameField: 'preferred_username',
      displayNameField: 'name',
      emailField: 'email',
      profilePictureField: 'picture',
    };

    it('stores the groups from a list claim', async () => {
      const request = await extractWithUserinfo(
        { groups: ['team', ' other ', '', 42] },
        { ...fieldConfig, groupsField: 'groups' },
      );
      expect(request.session.pendingUser?.groups).toEqual(['team', 'other']);
      expect(request.session.pendingUser?.providerUserId).toBe('carol-id');
    });

    it('stores the groups from a comma-separated claim', async () => {
      const request = await extractWithUserinfo(
        { roles: 'team, other,,' },
        { ...fieldConfig, groupsField: 'roles' },
      );
      expect(request.session.pendingUser?.groups).toEqual(['team', 'other']);
    });

    it('stores an empty list if the provider sends no groups', async () => {
      const request = await extractWithUserinfo(
        { groups: [] },
        { ...fieldConfig, groupsField: 'groups' },
      );
      expect(request.session.pendingUser?.groups).toEqual([]);
    });

    it('stores no groups if group sync is disabled', async () => {
      const request = await extractWithUserinfo({ groups: ['team'] }, fieldConfig);
      expect(request.session.pendingUser?.groups).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stores an empty list if the claim is missing', async () => {
      const request = await extractWithUserinfo({}, { ...fieldConfig, groupsField: 'groups' });
      expect(request.session.pendingUser?.groups).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stores no groups and warns if the claim has an unsupported type', async () => {
      const request = await extractWithUserinfo(
        { groups: { team: true } },
        { ...fieldConfig, groupsField: 'groups' },
      );
      expect(request.session.pendingUser?.groups).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncUserGroups', () => {
    const managedGroupPredicate = (): ((groupName: string) => boolean) =>
      jest.mocked(groupsService.syncGroupMemberships).mock.calls[0][2];

    it('throws NotFoundException for unknown OIDC identifier', async () => {
      await expect(oidcService.syncUserGroups('unknown-oidc', 7, ['team'])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does nothing if group sync is disabled', async () => {
      await oidcService.syncUserGroups(mockOidcConfig.identifier, 7, ['team']);
      expect(groupsService.syncGroupMemberships).not.toHaveBeenCalled();
    });

    it('does nothing if no groups were received', async () => {
      setClientConfig({ groupsField: 'groups' });
      await oidcService.syncUserGroups(mockOidcConfig.identifier, 7, undefined);
      expect(groupsService.syncGroupMemberships).not.toHaveBeenCalled();
    });

    it('ignores group names starting with an underscore', async () => {
      setClientConfig({ groupsField: 'groups' });
      await oidcService.syncUserGroups(mockOidcConfig.identifier, 7, [
        'team',
        '_EVERYONE',
        '_LOGGED_IN',
      ]);
      expect(groupsService.syncGroupMemberships).toHaveBeenCalledWith(
        7,
        ['team'],
        expect.any(Function),
      );
      expect(managedGroupPredicate()('_EVERYONE')).toBe(false);
      expect(managedGroupPredicate()('other')).toBe(true);
    });

    it('removes managed memberships if the provider sends no groups', async () => {
      setClientConfig({ groupsField: 'groups' });
      await oidcService.syncUserGroups(mockOidcConfig.identifier, 7, []);
      expect(groupsService.syncGroupMemberships).toHaveBeenCalledWith(7, [], expect.any(Function));
    });

    it('only manages groups matching the allow regex', async () => {
      setClientConfig({ groupsField: 'groups', groupsAllowRegex: '^enumera-' });
      await oidcService.syncUserGroups(mockOidcConfig.identifier, 7, ['enumera-team', 'other']);
      expect(groupsService.syncGroupMemberships).toHaveBeenCalledWith(
        7,
        ['enumera-team'],
        expect.any(Function),
      );
      expect(managedGroupPredicate()('other')).toBe(false);
      expect(managedGroupPredicate()('enumera-old')).toBe(true);
    });
  });

  describe('processBackchannelLogout', () => {
    it('throws NotFoundException for unknown OIDC identifier', async () => {
      await expect(
        oidcService.processBackchannelLogout('unknown-oidc', 'fake-token'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException if logout token is missing required claims', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        // Missing jti and events
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      await expect(
        oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'valid-jwt-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if logout token contains nonce claim', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        jti: 'unique-token-id',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
        sub: 'user-123',
        nonce: 'should-not-be-present',
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      await expect(
        oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'invalid-token-with-nonce'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if logout token missing both sub and sid', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        jti: 'unique-token-id',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
        // Missing both sub and sid
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      await expect(
        oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'invalid-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if logout token missing backchannel-logout event', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        jti: 'unique-token-id',
        events: {
          // Wrong event type
          'http://schemas.openid.net/event/some-other-event': {},
        },
        sub: 'user-123',
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      await expect(
        oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'invalid-event-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('terminates session by sid when sid is provided', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        jti: 'unique-token-id',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
        sid: 'session-123',
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      const mockTerminateByOidcSid =
        sessionService.terminateSessionByOidcSid as jest.MockedFunction<
          typeof sessionService.terminateSessionByOidcSid
        >;
      mockTerminateByOidcSid.mockResolvedValue(true);

      await oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'valid-sid-token');

      expect(mockTerminateByOidcSid).toHaveBeenCalledWith('session-123');
    });

    it('terminates all user sessions when only sub is provided', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        jti: 'unique-token-id',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
        sub: 'user-123',
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      const mockIdentity: Identity = {
        [FieldNameIdentity.userId]: 42,
        [FieldNameIdentity.providerUserId]: 'user-123',
        [FieldNameIdentity.providerType]: AuthProviderType.OIDC,
        [FieldNameIdentity.providerIdentifier]: mockOidcConfig.identifier,
        [FieldNameIdentity.passwordHash]: null,
        [FieldNameIdentity.createdAt]: new Date().toISOString(),
        [FieldNameIdentity.updatedAt]: new Date().toISOString(),
      };

      const mockGetIdentity =
        identityService.getIdentityFromUserIdAndProviderType as jest.MockedFunction<
          typeof identityService.getIdentityFromUserIdAndProviderType
        >;
      mockGetIdentity.mockResolvedValue(mockIdentity);

      const mockTerminateAll = sessionService.terminateAllSessionsOfUser as jest.MockedFunction<
        typeof sessionService.terminateAllSessionsOfUser
      >;
      mockTerminateAll.mockResolvedValue(3);

      await oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'valid-sub-token');

      expect(mockGetIdentity).toHaveBeenCalledWith(
        'user-123',
        AuthProviderType.OIDC,
        mockOidcConfig.identifier,
      );
      expect(mockTerminateAll).toHaveBeenCalledWith(42);
    });

    it('does not throw an error if no sessions are found', async () => {
      const mockJwtVerify = jose.jwtVerify as jest.MockedFunction<typeof jose.jwtVerify>;
      const mockPayload: JWTPayload = {
        iss: 'https://oidc.example.com',
        aud: 'test-client-id',
        iat: Date.now() / 1000,
        jti: 'unique-token-id',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
        sid: 'non-existent-session',
      };
      mockJwtVerify.mockResolvedValue({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      });

      const mockTerminateByOidcSid =
        sessionService.terminateSessionByOidcSid as jest.MockedFunction<
          typeof sessionService.terminateSessionByOidcSid
        >;
      mockTerminateByOidcSid.mockResolvedValue(false);

      await expect(
        oidcService.processBackchannelLogout(mockOidcConfig.identifier, 'valid-token-no-session'),
      ).resolves.not.toThrow();
    });
  });
});
