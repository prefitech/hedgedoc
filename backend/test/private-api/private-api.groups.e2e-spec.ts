import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { FieldNameGroup, SpecialGroup } from '@hedgedoc/database';
import { PRIVATE_API_PREFIX } from '../../src/app.module';
import { createDefaultMockNoteConfig } from '../../src/config/mock/note.config.mock';
import { NoteConfig } from '../../src/config/note.config';
import { AlreadyInDBError } from '../../src/errors/errors';
import { TestSetup, TestSetupBuilder } from '../test-setup';
import { setupAgent } from './utils/setup-agent';
/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import request from 'supertest';

describe('Groups', () => {
  let testSetup: TestSetup;
  const noteConfigMock: NoteConfig = createDefaultMockNoteConfig();

  const testGroupName = 'test_group_1';
  const testGroupDisplayName = 'Test Group 1';

  let agentUser1: request.SuperAgentTest;

  beforeEach(async () => {
    testSetup = await TestSetupBuilder.create({
      noteConfigMock: noteConfigMock,
    })
      .withUsers()
      .withNotes()
      .build();

    await testSetup.init();

    const agents = await setupAgent(testSetup);
    agentUser1 = agents[2];

    // create a test group
    await testSetup.groupService.createGroup(testGroupName, testGroupDisplayName);
  });

  afterEach(async () => {
    await testSetup.cleanup();
  });

  describe(`${PRIVATE_API_PREFIX}/groups/:groupName`, () => {
    test('details for an existing groups can be retrieved', async () => {
      const response = await agentUser1.get(`${PRIVATE_API_PREFIX}/groups/${testGroupName}`);
      expect(response.status).toBe(200);
      expect(response.body.name).toBe(testGroupName);
      expect(response.body.displayName).toBe(testGroupDisplayName);
      expect(response.body.isSpecial).toBe(false);
    });

    test('details for non-existing groups cannot be retrieved', async () => {
      const response = await agentUser1.get(`${PRIVATE_API_PREFIX}/groups/i_dont_exist`);
      expect(response.status).toBe(404);
    });
  });

  describe('syncGroupMemberships', () => {
    const groupNamesOf = async (userId: number): Promise<string[]> =>
      (await testSetup.groupService.getGroupsForUser(userId)).map(
        (group) => group[FieldNameGroup.name],
      );

    test('creates missing groups and memberships and is idempotent', async () => {
      const userId = testSetup.userIds[0];
      await testSetup.groupService.syncGroupMemberships(userId, ['sync_a', 'sync_b'], () => true);
      await testSetup.groupService.syncGroupMemberships(userId, ['sync_a', 'sync_b'], () => true);
      const names = await groupNamesOf(userId);
      expect(names.filter((name) => name === 'sync_a')).toHaveLength(1);
      expect(names.filter((name) => name === 'sync_b')).toHaveLength(1);
      expect(await testSetup.groupService.getGroupInfoDtoByName('sync_a')).toEqual({
        name: 'sync_a',
        displayName: 'sync_a',
        isSpecial: false,
      });
      expect(await groupNamesOf(testSetup.userIds[1])).not.toContain('sync_a');
    });

    test('adds existing groups without creating duplicates', async () => {
      const userId = testSetup.userIds[0];
      await testSetup.groupService.syncGroupMemberships(userId, [testGroupName], () => true);
      expect(await groupNamesOf(userId)).toContain(testGroupName);
      const group = await testSetup.groupService.getGroupInfoDtoByName(testGroupName);
      expect(group.displayName).toBe(testGroupDisplayName);
      await expect(testSetup.groupService.createGroup(testGroupName, 'Duplicate')).rejects.toThrow(
        AlreadyInDBError,
      );
    });

    test('removes only memberships in managed groups', async () => {
      const userId = testSetup.userIds[0];
      await testSetup.groupService.syncGroupMemberships(userId, ['keep_me', 'drop_me'], () => true);
      await testSetup.groupService.syncGroupMemberships(userId, [], (name) =>
        name.startsWith('drop_'),
      );
      const names = await groupNamesOf(userId);
      expect(names).toContain('keep_me');
      expect(names).not.toContain('drop_me');
    });

    test('never adds memberships in special groups', async () => {
      const userId = testSetup.userIds[0];
      await testSetup.groupService.syncGroupMemberships(
        userId,
        [SpecialGroup.EVERYONE, SpecialGroup.LOGGED_IN],
        () => true,
      );
      const names = await groupNamesOf(userId);
      expect(names.filter((name) => name === SpecialGroup.EVERYONE)).toHaveLength(1);
      expect(names.filter((name) => name === SpecialGroup.LOGGED_IN)).toHaveLength(1);
    });
  });
});
