/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AuthProviderType } from '@hedgedoc/commons';
import { Mock } from 'ts-mockery';

import type { IdentityService } from '../../../auth/identity.service';
import type { OidcService } from '../../../auth/oidc/oidc.service';
import type { PendingUserConfirmationDto } from '../../../dtos/pending-user-confirmation.dto';
import type { ConsoleLoggerService } from '../../../logger/console-logger.service';
import type { RequestWithSession } from '../../utils/request.type';
import { AuthController } from './auth.controller';

describe('AuthController', () => {
  let controller: AuthController;
  let identityService: IdentityService;
  let oidcService: OidcService;

  const confirmationData = Mock.of<PendingUserConfirmationDto>({
    username: 'carol',
    displayName: 'Carol',
    profilePicture: undefined,
  });

  const createRequest = (
    authProviderType: AuthProviderType,
    groups: string[] | undefined,
  ): RequestWithSession =>
    Mock.of<RequestWithSession>({
      session: {
        csrfToken: null,
        loginAuthProviderIdentifier: null,
        loginAuthProviderType: null,
        pendingUser: {
          authProviderType,
          authProviderIdentifier: 'keycloak',
          providerUserId: 'carol-id',
          confirmationData: {
            username: 'carol',
            displayName: 'Carol',
            photoUrl: null,
            email: null,
          },
          groups,
        },
        save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        userId: null,
      },
    });

  beforeEach(() => {
    const logger = Mock.of<ConsoleLoggerService>({
      setContext: jest.fn(),
    });
    identityService = Mock.of<IdentityService>({
      createUserWithIdentityFromPendingUserConfirmation: jest.fn(() => Promise.resolve(7)),
    });
    oidcService = Mock.of<OidcService>({
      syncUserGroups: jest.fn(() => Promise.resolve()),
    });
    controller = new AuthController(logger, identityService, oidcService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('confirmPendingUserData', () => {
    it('syncs the groups of a new OIDC user and logs them in', async () => {
      const request = createRequest(AuthProviderType.OIDC, ['team']);

      await controller.confirmPendingUserData(request, confirmationData);

      expect(oidcService.syncUserGroups).toHaveBeenCalledWith('keycloak', 7, ['team']);
      expect(request.session.userId).toBe(7);
      expect(request.session.loginAuthProviderType).toBe(AuthProviderType.OIDC);
      expect(request.session.pendingUser).toBeNull();
    });

    it('does not sync groups for other auth providers', async () => {
      const request = createRequest(AuthProviderType.LDAP, undefined);

      await controller.confirmPendingUserData(request, confirmationData);

      expect(oidcService.syncUserGroups).not.toHaveBeenCalled();
      expect(request.session.userId).toBe(7);
    });

    it('does not log the user in if the group sync fails', async () => {
      const request = createRequest(AuthProviderType.OIDC, ['team']);
      jest
        .spyOn(oidcService, 'syncUserGroups')
        .mockRejectedValue(new Error('Database unavailable'));

      await expect(controller.confirmPendingUserData(request, confirmationData)).rejects.toThrow(
        'Database unavailable',
      );
      expect(request.session.userId).toBeNull();
    });
  });
});
