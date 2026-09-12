/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import {
  FieldNameGroup,
  FieldNameGroupUser,
  Group,
  SpecialGroup,
  TableGroup,
  TableGroupUser,
} from '@hedgedoc/database';
import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { InjectConnection } from 'nest-knexjs';

import { GroupInfoDto } from '../dtos/group-info.dto';
import { AlreadyInDBError, NotInDBError } from '../errors/errors';
import { ConsoleLoggerService } from '../logger/console-logger.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class GroupsService {
  constructor(
    private readonly logger: ConsoleLoggerService,

    @InjectConnection()
    private readonly knex: Knex,

    private readonly usersService: UsersService,
  ) {
    this.logger.setContext(GroupsService.name);
  }

  /**
   * Create a new group with a given name and displayName
   *
   * @param name The group name as identifier the new group shall have
   * @param displayName The display name the new group shall have
   * @throws AlreadyInDBError if the group name is already taken
   */
  async createGroup(name: string, displayName: string): Promise<void> {
    try {
      await this.knex(TableGroup).insert({
        [FieldNameGroup.name]: name,
        [FieldNameGroup.displayName]: displayName,
        [FieldNameGroup.isSpecial]: false,
      });
    } catch {
      const message = `A group with the name '${name}' already exists.`;
      this.logger.debug(message, 'createGroup');
      throw new AlreadyInDBError(message);
    }
  }

  /**
   * Fetches a group by its identifier name
   *
   * @param name Name of the group to query
   * @returns The group's metadata
   * @throws NotInDBError if there is no group with this name
   */
  async getGroupInfoDtoByName(name: string): Promise<GroupInfoDto> {
    const group = await this.getRawGroupByName(name);
    if (group === undefined) {
      throw new NotInDBError(`Group with name '${name}' not found`);
    }
    return GroupInfoDto.create({
      name: group[FieldNameGroup.name],
      displayName: group[FieldNameGroup.displayName],
      isSpecial: Boolean(group[FieldNameGroup.isSpecial]),
    });
  }

  /**
   * Fetches a groupId by its identifier name
   *
   * @param name Name of the group to query
   * @param transaction The optional database transaction to use
   * @returns The groupId
   * @throws NotInDBError if there is no group with this name
   */
  async getGroupIdByName(name: string, transaction?: Knex): Promise<number> {
    const dbActor = transaction ?? this.knex;
    const group = await dbActor(TableGroup)
      .select(FieldNameGroup.id)
      .where(FieldNameGroup.name, name)
      .first();
    if (group === undefined) {
      throw new NotInDBError(`Group with name '${name}' not found`);
    }
    return group[FieldNameGroup.id];
  }

  /**
   * Fetches a raw database group object by its identifier name
   * @param name The identifier name to fetch
   * @param transaction The optional database transaction to use
   * @returns The raw database group object
   * @throws NotInDBError if there is no group with this name
   */
  private async getRawGroupByName(name: string, transaction?: Knex): Promise<Group | undefined> {
    const dbActor = transaction ?? this.knex;
    return await dbActor(TableGroup).select().where(FieldNameGroup.name, name).first();
  }

  /**
   * Synchronizes the group memberships of a user with a list of group names from an external auth provider
   *
   * Groups that do not exist yet are created with their name as display name.
   * Memberships in groups that are not in the list are removed, but only if isManagedGroup returns true for them.
   * Special groups are never added or removed.
   *
   * @param userId The id of the user whose memberships should be synchronized
   * @param groupNames The names of the groups the user should be a member of
   * @param isManagedGroup Decides whether the membership in a group with the given name may be removed
   */
  async syncGroupMemberships(
    userId: number,
    groupNames: string[],
    isManagedGroup: (groupName: string) => boolean,
  ): Promise<void> {
    const uniqueGroupNames = [...new Set(groupNames)];
    await this.knex.transaction(async (transaction) => {
      let wantedGroupIds: number[] = [];
      if (uniqueGroupNames.length > 0) {
        await transaction(TableGroup)
          .insert(
            uniqueGroupNames.map((name) => ({
              [FieldNameGroup.name]: name,
              [FieldNameGroup.displayName]: name,
              [FieldNameGroup.isSpecial]: false,
            })),
          )
          .onConflict(FieldNameGroup.name)
          .ignore();
        const wantedGroups = await transaction(TableGroup)
          .select<Pick<Group, FieldNameGroup.id>[]>(FieldNameGroup.id)
          .whereIn(FieldNameGroup.name, uniqueGroupNames)
          .andWhere(FieldNameGroup.isSpecial, false);
        wantedGroupIds = wantedGroups.map((group) => group[FieldNameGroup.id]);
      }

      const currentGroups = await transaction(TableGroup)
        .join(
          TableGroupUser,
          `${TableGroup}.${FieldNameGroup.id}`,
          `${TableGroupUser}.${FieldNameGroupUser.groupId}`,
        )
        .select<Pick<Group, FieldNameGroup.id | FieldNameGroup.name | FieldNameGroup.isSpecial>[]>(
          `${TableGroup}.${FieldNameGroup.id}`,
          `${TableGroup}.${FieldNameGroup.name}`,
          `${TableGroup}.${FieldNameGroup.isSpecial}`,
        )
        .where(`${TableGroupUser}.${FieldNameGroupUser.userId}`, userId);
      const currentGroupIds = new Set(currentGroups.map((group) => group[FieldNameGroup.id]));
      const wantedGroupIdSet = new Set(wantedGroupIds);

      const groupIdsToAdd = wantedGroupIds.filter((groupId) => !currentGroupIds.has(groupId));
      const groupIdsToRemove = currentGroups
        .filter(
          (group) =>
            !group[FieldNameGroup.isSpecial] &&
            isManagedGroup(group[FieldNameGroup.name]) &&
            !wantedGroupIdSet.has(group[FieldNameGroup.id]),
        )
        .map((group) => group[FieldNameGroup.id]);

      if (groupIdsToAdd.length > 0) {
        await transaction(TableGroupUser)
          .insert(
            groupIdsToAdd.map((groupId) => ({
              [FieldNameGroupUser.userId]: userId,
              [FieldNameGroupUser.groupId]: groupId,
            })),
          )
          .onConflict([FieldNameGroupUser.userId, FieldNameGroupUser.groupId])
          .ignore();
      }
      if (groupIdsToRemove.length > 0) {
        await transaction(TableGroupUser)
          .where(FieldNameGroupUser.userId, userId)
          .whereIn(FieldNameGroupUser.groupId, groupIdsToRemove)
          .delete();
      }
      this.logger.debug(
        `Synchronized groups of user ${userId}: added ${groupIdsToAdd.length}, removed ${groupIdsToRemove.length}`,
        'syncGroupMemberships',
      );
    });
  }

  /**
   * Fetches all groups the user is a member of, including the special groups
   *
   * @param userId The id of the user to fetch the groups for
   * @param transaction The optional transaction to use, if none provided a new transaction will be opened
   * @returns A list of group objects that the given user is member of
   */
  getGroupsForUser(userId: number, transaction?: Knex): Promise<Group[]> {
    // Reuse existing transaction
    if (transaction) {
      return this.innerGetGroupsForUser(userId, transaction);
    }
    // Create a new transaction if no transaction is provided
    return this.knex.transaction(async (transaction) => {
      return await this.innerGetGroupsForUser(userId, transaction);
    });
  }

  private async innerGetGroupsForUser(userId: number, transaction: Knex): Promise<Group[]> {
    const specialGroupEveryone = await this.getRawGroupByName(SpecialGroup.EVERYONE, transaction);
    if (specialGroupEveryone === undefined) {
      throw new NotInDBError(
        `Special group '${SpecialGroup.EVERYONE}' not found. Did the database migrations run?`,
      );
    }
    const dbGroups = await transaction(TableGroup)
      .join(
        TableGroupUser,
        `${TableGroup}.${FieldNameGroup.id}`,
        `${TableGroupUser}.${FieldNameGroupUser.groupId}`,
      )
      .where(`${TableGroupUser}.${FieldNameGroupUser.userId}`, userId)
      .select();
    const isRegisteredUser = await this.usersService.isRegisteredUser(userId, transaction);
    if (isRegisteredUser) {
      const specialGroupLoggedIn = await this.getRawGroupByName(
        SpecialGroup.LOGGED_IN,
        transaction,
      );
      if (specialGroupLoggedIn === undefined) {
        throw new NotInDBError(
          `Special group '${SpecialGroup.LOGGED_IN}' not found. Did the database migrations run?`,
        );
      }
      return [specialGroupEveryone, specialGroupLoggedIn, ...dbGroups];
    } else {
      return [specialGroupEveryone, ...dbGroups];
    }
  }
}
