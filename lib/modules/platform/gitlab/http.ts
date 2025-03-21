import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { GitlabHttp } from '../../../util/http/gitlab';
import type { GitLabUser, GitlabUserStatus } from './types';

export const gitlabApi = new GitlabHttp();

export async function getUserID(username: string): Promise<number> {
  const userInfo = (
    await gitlabApi.getJsonUnchecked<{ id: number }[]>(
      `users?username=${username}`,
    )
  ).body;

  if (is.emptyArray(userInfo)) {
    throw new Error(
      `User ID for the username: ${username} could not be found.`,
    );
  }

  return userInfo[0].id;
}

async function getMembers(group: string): Promise<GitLabUser[]> {
  const groupEncoded = encodeURIComponent(group);
  return (
    await gitlabApi.getJsonUnchecked<GitLabUser[]>(
      `groups/${groupEncoded}/members`,
    )
  ).body;
}

export async function getMemberUserIDs(group: string): Promise<number[]> {
  const members = await getMembers(group);
  return members.map((u) => u.id);
}

export async function getMemberUsernames(group: string): Promise<string[]> {
  const members = await getMembers(group);
  return members.map((u) => u.username);
}

export async function isUserBusy(user: string): Promise<boolean> {
  try {
    const url = `/users/${user}/status`;
    const userStatus = (await gitlabApi.getJsonUnchecked<GitlabUserStatus>(url))
      .body;
    return userStatus.availability === 'busy';
  } catch (err) {
    logger.warn({ err }, 'Failed to get user status');
    return false;
  }
}
