import { router } from 'expo-router';

import type { WorkspaceNavigation, WorkspaceSection } from '@entities/workspace';

const sectionPaths = {
  sessions: '/',
  hosts: '/hosts',
  settings: '/settings',
  groups: '/groups',
} as const satisfies Record<WorkspaceSection, string>;

/** The only adapter from workspace intentions to concrete Expo routes. */
export const workspaceNavigation: WorkspaceNavigation = {
  openSession: id => router.push({ pathname: '/session/[id]', params: { id } }),
  returnToSessions: () => router.dismissTo(sectionPaths.sessions),
  navigateTo: section => router.navigate(sectionPaths[section]),
};
