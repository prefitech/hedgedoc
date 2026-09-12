/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { AuthProviderType } from '@hedgedoc/commons';
import { FieldNameIdentity, Identity } from '@hedgedoc/database';
import { UnauthorizedException } from '@nestjs/common';
import { errors as oidcErrors } from 'openid-client';
import { Mock } from 'ts-mockery';

import type { IdentityService } from '../../../../auth/identity.service';
import type { OidcService } from '../../../../auth/oidc/oidc.service';
import type { ConsoleLoggerService } from '../../../../logger/console-logger.service';
import type { UsersService } from '../../../../users/users.service';
import type { RequestWithSession } from '../../../utils/request.type';
import { OidcController } from './oidc.controller';

describe('OidcController', () => {
  let controller: OidcController;
  let oidcService: OidcService;
  let saveSession: jest.Mock<() => Promise<void>>;

  saveSession = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockRequest = Mock.of<RequestWithSession>({
    headers: {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    },
    session: {
      csrfToken: null,
      loginAuthProviderIdentifier: null,
      loginAuthProviderType: null,
      oidc: {
        idToken: null,
        loginCode: 'code',
        loginState: 'state',
        sid: null,
      },
      pendingUser: {
        authProviderIdentifier: 'test',
      },
      save: saveSession,
      userId: null,
    },
  });

  const expectSessionIsCleared = () => {
    expect(mockRequest.session.pendingUser).toBeNull();
    expect(mockRequest.session.oidc.loginCode).toBeNull();
    expect(mockRequest.session.oidc.loginState).toBeNull();
    expect(saveSession).toHaveBeenCalledTimes(1);
  };

  beforeEach(() => {
    const logger = Mock.of<ConsoleLoggerService>({
      error: jest.fn(),
      log: jest.fn(),
      setContext: jest.fn(),
    });
    const usersService = Mock.of<UsersService>({});
    const identityService = Mock.of<IdentityService>({
      mayUpdateIdentity: jest.fn(() => false),
    });
    oidcService = Mock.of<OidcService>({
      extractUserInfoFromCallback: jest.fn(),
      getExistingOidcIdentity: jest.fn<OidcService['getExistingOidcIdentity']>(),
      syncUserGroups: jest.fn(),
    });
    controller = new OidcController(logger, usersService, identityService, oidcService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('redirects provider errors with their description', async () => {
    jest.spyOn(oidcService, 'extractUserInfoFromCallback').mockRejectedValue(
      new oidcErrors.OPError({
        error: 'access_denied',
        error_description: 'The user cancelled the login',
      }),
    );

    await expect(controller.callback('test', mockRequest)).resolves.toEqual({
      url: '/login?error=provider&providerError=access_denied&providerDescription=The+user+cancelled+the+login',
    });
    expectSessionIsCleared();
  });

  it('redirects RP validation errors', async () => {
    jest
      .spyOn(oidcService, 'extractUserInfoFromCallback')
      .mockRejectedValue(new oidcErrors.RPError({ message: 'state mismatch' }));

    await expect(controller.callback('test', mockRequest)).resolves.toEqual({
      url: '/login?error=invalid-response',
    });
    expectSessionIsCleared();
  });

  it('redirects expected callback errors', async () => {
    jest
      .spyOn(oidcService, 'extractUserInfoFromCallback')
      .mockRejectedValue(new UnauthorizedException('Missing user identifier'));

    await expect(controller.callback('test', mockRequest)).resolves.toEqual({
      url: '/login?error=invalid-response',
    });
    expectSessionIsCleared();
  });

  it('redirects unexpected callback errors', async () => {
    jest
      .spyOn(oidcService, 'extractUserInfoFromCallback')
      .mockRejectedValue(new Error('Database unavailable'));

    await expect(controller.callback('test', mockRequest)).resolves.toEqual({
      url: '/login?error=internal',
    });
    expectSessionIsCleared();
  });

  it('redirects callback errors when no oidc session data exists yet', async () => {
    const noOidcRequest = Mock.of<RequestWithSession>({
      headers: {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
      },
      session: {
        csrfToken: null,
        loginAuthProviderIdentifier: null,
        loginAuthProviderType: null,
        pendingUser: null,
        save: saveSession,
        userId: null,
      } as unknown as RequestWithSession['session'],
    });
    jest
      .spyOn(oidcService, 'extractUserInfoFromCallback')
      .mockRejectedValue(new oidcErrors.RPError({ message: 'state mismatch' }));

    await expect(controller.callback('test', noOidcRequest)).resolves.toEqual({
      url: '/login?error=invalid-response',
    });
    expect(noOidcRequest.session.pendingUser).toBeNull();
    expect(noOidcRequest.session.oidc).toEqual({
      idToken: null,
      sid: null,
      loginCode: null,
      loginState: null,
    });
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  describe('group sync', () => {
    const userInfo = { username: 'carol', displayName: 'Carol', photoUrl: null, email: null };
    let request: RequestWithSession;

    beforeEach(() => {
      request = Mock.of<RequestWithSession>({
        headers: {
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
        },
        session: {
          csrfToken: null,
          loginAuthProviderIdentifier: null,
          loginAuthProviderType: null,
          oidc: {
            idToken: null,
            loginCode: 'code',
            loginState: 'state',
            sid: null,
          },
          pendingUser: null,
          save: saveSession,
          userId: null,
        },
      });
      jest.spyOn(oidcService, 'extractUserInfoFromCallback').mockImplementation(() => {
        request.session.pendingUser = {
          authProviderType: AuthProviderType.OIDC,
          authProviderIdentifier: 'test',
          providerUserId: 'carol-id',
          confirmationData: userInfo,
          groups: ['team'],
        };
        return Promise.resolve(userInfo);
      });
    });

    it('syncs the groups of a returning user', async () => {
      jest
        .spyOn(oidcService, 'getExistingOidcIdentity')
        .mockResolvedValue(Mock.of<Identity>({ [FieldNameIdentity.userId]: 7 }));

      await expect(controller.callback('test', request)).resolves.toEqual({ url: '/' });
      expect(oidcService.syncUserGroups).toHaveBeenCalledWith('test', 7, ['team']);
      expect(request.session.userId).toBe(7);
    });

    it('does not sync groups before a new user is confirmed', async () => {
      jest.spyOn(oidcService, 'getExistingOidcIdentity').mockResolvedValue(null);

      await expect(controller.callback('test', request)).resolves.toEqual({ url: '/new-user' });
      expect(oidcService.syncUserGroups).not.toHaveBeenCalled();
      expect(request.session.pendingUser?.groups).toEqual(['team']);
    });

    it('does not log the user in if the group sync fails', async () => {
      jest
        .spyOn(oidcService, 'getExistingOidcIdentity')
        .mockResolvedValue(Mock.of<Identity>({ [FieldNameIdentity.userId]: 7 }));
      jest
        .spyOn(oidcService, 'syncUserGroups')
        .mockRejectedValue(new Error('Database unavailable'));

      await expect(controller.callback('test', request)).resolves.toEqual({
        url: '/login?error=internal',
      });
      expect(request.session.userId).toBeNull();
      expect(request.session.pendingUser).toBeNull();
    });
  });
});
