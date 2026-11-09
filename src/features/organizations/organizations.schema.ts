import { pgTable, text, timestamp, boolean, unique, index } from 'drizzle-orm/pg-core';
import { profiles } from '../profiles/profiles.schema';

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => profiles.id),
  name: text('name').notNull(),
  orgname: text('orgname').notNull().unique(),
  description: text('description'),
  isPrivate: boolean('is_private').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const organizationMembers = pgTable('organization_members', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  profileId: text('profile_id').notNull().references(() => profiles.id),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('pending'),
  invitedBy: text('invited_by').references(() => profiles.id),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
}, (table) => ({
  orgProfileUnique: unique().on(table.orgId, table.profileId),
  profileIdx: index('organization_members_profile_id_idx').on(table.profileId),
}));

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;