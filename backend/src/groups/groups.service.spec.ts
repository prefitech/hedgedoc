/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import {
  FieldNameGroup,
  FieldNameGroupUser,
  Group,
  TableGroup,
  TableGroupUser,
} from '@hedgedoc/database';
import { Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Tracker } from 'knex-mock-client';

import appConfigMock from '../config/mock/app.config.mock';
import databaseConfigMock from '../config/mock/database.config.mock';
import { expectBindings } from '../database/mock/expect-bindings';
import { mockInsert, mockSelect } from '../database/mock/mock-queries';
import { mockKnexDb } from '../database/mock/provider';
import { AlreadyInDBError, NotInDBError } from '../errors/errors';
import { LoggerModule } from '../logger/logger.module';
import { UsersService } from '../users/users.service';
import { GroupsService } from './groups.service';

describe('GroupsService', () => {
  const groupName = 'test_group';
  const groupDisplayName = 'Test Group';
  const groupId = 42;

  let service: GroupsService;
  let usersService: UsersService;
  let tracker: Tracker;
  let knexProvider: Provider;

  beforeAll(async () => {
    [tracker, knexProvider] = mockKnexDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, GroupsService, knexProvider],
      imports: [
        LoggerModule,
        await ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfigMock, databaseConfigMock],
        }),
      ],
    }).compile();

    service = module.get<GroupsService>(GroupsService);
    usersService = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    tracker.reset();
  });

  describe('createGroup', () => {
    it('inserts a new group', async () => {
      mockInsert(tracker, TableGroup, [
        FieldNameGroup.displayName,
        FieldNameGroup.isSpecial,
        FieldNameGroup.name,
      ]);
      await service.createGroup(groupName, groupDisplayName);
      expectBindings(tracker, 'insert', [[groupDisplayName, false, groupName]]);
    });

    it('throws AlreadyInDBError if group already exists', async () => {
      tracker.on
        .insert(/^insert into "group" \("display_name", "is_special", "name"\) values .*/)
        .simulateError('duplicate key value violates unique constraint');
      await expect(service.createGroup(groupName, groupDisplayName)).rejects.toThrow(
        AlreadyInDBError,
      );
    });
  });

  describe('getGroupInfoDtoByName', () => {
    it('returns group info if found', async () => {
      const groupRow = {
        [FieldNameGroup.name]: groupName,
        [FieldNameGroup.displayName]: groupDisplayName,
        [FieldNameGroup.isSpecial]: false,
      };
      mockSelect(tracker, [], TableGroup, FieldNameGroup.name, groupRow);
      const result = await service.getGroupInfoDtoByName(groupName);
      expect(result).toEqual({
        name: groupName,
        displayName: groupDisplayName,
        isSpecial: false,
      });
      expectBindings(tracker, 'select', [[groupName]], true);
    });

    it('throws NotInDBError if group not found', async () => {
      mockSelect(tracker, [], TableGroup, FieldNameGroup.name, undefined);
      await expect(service.getGroupInfoDtoByName(groupName)).rejects.toThrow(NotInDBError);
      expectBindings(tracker, 'select', [[groupName]], true);
    });
  });

  describe('getGroupIdByName', () => {
    it('returns group id if found', async () => {
      const groupRow = {
        [FieldNameGroup.id]: groupId,
      };
      mockSelect(tracker, [FieldNameGroup.id], TableGroup, FieldNameGroup.name, groupRow);
      const result = await service.getGroupIdByName(groupName);
      expect(result).toBe(groupId);
      expectBindings(tracker, 'select', [[groupName]], true);
    });

    it('throws NotInDBError if group not found', async () => {
      mockSelect(tracker, [FieldNameGroup.id], TableGroup, FieldNameGroup.name, undefined);
      await expect(service.getGroupIdByName(groupName)).rejects.toThrow(NotInDBError);
      expectBindings(tracker, 'select', [[groupName]], true);
    });
  });

  describe('getGroupsForUser', () => {
    const mockEveryoneGroup: Group = {
      [FieldNameGroup.id]: 1,
      [FieldNameGroup.name]: 'EVERYONE',
      [FieldNameGroup.displayName]: 'Everyone',
      [FieldNameGroup.isSpecial]: true,
    };
    const mockLoggedInGroup: Group = {
      [FieldNameGroup.id]: 2,
      [FieldNameGroup.name]: 'LOGGED_IN',
      [FieldNameGroup.displayName]: 'Logged-in',
      [FieldNameGroup.isSpecial]: true,
    };
    const mockUserGroup1: Group = {
      [FieldNameGroup.id]: 3,
      [FieldNameGroup.name]: 'mock',
      [FieldNameGroup.displayName]: 'Mock',
      [FieldNameGroup.isSpecial]: false,
    };

    beforeEach(() => {
      mockSelect(tracker, [], TableGroup, FieldNameGroup.name, mockEveryoneGroup);
    });

    it('returns EVERYONE, LOGGED_IN, and user groups for registered user', async () => {
      mockSelect(
        tracker,
        [],
        TableGroup,
        FieldNameGroupUser.userId,
        [mockUserGroup1],
        [
          {
            joinTable: TableGroupUser,
            keyLeft: FieldNameGroupUser.groupId,
            keyRight: FieldNameGroup.id,
          },
        ],
      );
      jest.spyOn(usersService, 'isRegisteredUser').mockResolvedValueOnce(true);
      mockSelect(tracker, [], TableGroup, FieldNameGroup.name, mockLoggedInGroup);
      const result = await service.getGroupsForUser(123);
      expect(result).toEqual([mockEveryoneGroup, mockLoggedInGroup, mockUserGroup1]);
    });

    it('returns EVERYONE and user groups for unregistered user', async () => {
      mockSelect(
        tracker,
        [],
        TableGroup,
        FieldNameGroupUser.userId,
        [mockUserGroup1],
        [
          {
            joinTable: TableGroupUser,
            keyLeft: FieldNameGroupUser.groupId,
            keyRight: FieldNameGroup.id,
          },
        ],
      );
      jest.spyOn(usersService, 'isRegisteredUser').mockResolvedValueOnce(false);
      const result = await service.getGroupsForUser(123);
      expect(result).toEqual([mockEveryoneGroup, mockUserGroup1]);
    });
  });

  describe('syncGroupMemberships', () => {
    const userId = 123;
    const mockCurrentGroupsQuery = (rows: unknown[]) => {
      tracker.on
        .select(
          /^select "group"\."id", "group"\."name", "group"\."is_special" from "group" inner join "group_user" on "group"\."id" = "group_user"\."group_id" where "group_user"\."user_id" = \$1/,
        )
        .responseOnce(rows);
    };

    it('creates missing groups, adds new memberships and removes managed ones', async () => {
      mockInsert(tracker, TableGroup, [
        FieldNameGroup.displayName,
        FieldNameGroup.isSpecial,
        FieldNameGroup.name,
      ]);
      mockSelect(
        tracker,
        [FieldNameGroup.id],
        TableGroup,
        [FieldNameGroup.name, FieldNameGroup.isSpecial],
        [{ [FieldNameGroup.id]: 10 }, { [FieldNameGroup.id]: 11 }],
      );
      mockCurrentGroupsQuery([
        {
          [FieldNameGroup.id]: 1,
          [FieldNameGroup.name]: '_EVERYONE',
          [FieldNameGroup.isSpecial]: true,
        },
        { [FieldNameGroup.id]: 11, [FieldNameGroup.name]: 'b', [FieldNameGroup.isSpecial]: false },
        {
          [FieldNameGroup.id]: 12,
          [FieldNameGroup.name]: 'old',
          [FieldNameGroup.isSpecial]: false,
        },
        {
          [FieldNameGroup.id]: 13,
          [FieldNameGroup.name]: 'unmanaged',
          [FieldNameGroup.isSpecial]: false,
        },
      ]);
      mockInsert(tracker, TableGroupUser, [FieldNameGroupUser.groupId, FieldNameGroupUser.userId]);
      tracker.on
        .delete(/^delete from "group_user" where "user_id" = \$1 and "group_id" in \(\$2\)/)
        .responseOnce(1);

      await service.syncGroupMemberships(userId, ['a', 'b', 'a'], (name) => name !== 'unmanaged');

      expect(tracker.history.insert).toHaveLength(2);
      expect(tracker.history.insert[0].sql).toContain('on conflict ("name") do nothing');
      expect(tracker.history.insert[0].bindings).toEqual(['a', false, 'a', 'b', false, 'b']);
      expect(tracker.history.insert[1].sql).toContain(
        'on conflict ("user_id", "group_id") do nothing',
      );
      expect(tracker.history.insert[1].bindings).toEqual([10, userId]);
      expect(tracker.history.delete).toHaveLength(1);
      expect(tracker.history.delete[0].bindings).toEqual([userId, 12]);
    });

    it('does not write memberships if nothing changed', async () => {
      mockInsert(tracker, TableGroup, [
        FieldNameGroup.displayName,
        FieldNameGroup.isSpecial,
        FieldNameGroup.name,
      ]);
      mockSelect(
        tracker,
        [FieldNameGroup.id],
        TableGroup,
        [FieldNameGroup.name, FieldNameGroup.isSpecial],
        [{ [FieldNameGroup.id]: 10 }],
      );
      mockCurrentGroupsQuery([
        { [FieldNameGroup.id]: 10, [FieldNameGroup.name]: 'a', [FieldNameGroup.isSpecial]: false },
      ]);

      await service.syncGroupMemberships(userId, ['a'], () => true);

      expect(tracker.history.insert).toHaveLength(1);
      expect(tracker.history.delete).toHaveLength(0);
    });

    it('removes all managed memberships if no groups are given', async () => {
      mockCurrentGroupsQuery([
        {
          [FieldNameGroup.id]: 12,
          [FieldNameGroup.name]: 'old',
          [FieldNameGroup.isSpecial]: false,
        },
      ]);
      tracker.on
        .delete(/^delete from "group_user" where "user_id" = \$1 and "group_id" in \(\$2\)/)
        .responseOnce(1);

      await service.syncGroupMemberships(userId, [], () => true);

      expect(tracker.history.insert).toHaveLength(0);
      expect(tracker.history.select).toHaveLength(1);
      expect(tracker.history.delete[0].bindings).toEqual([userId, 12]);
    });
  });
});
