/**
 * Chat-related type definitions
 */

export interface PlatformInfo {
  name: string;
  platform?: string;
}

export interface PendingRequest {
  updatedAt?: string;
  id: string;
  name: string;
  time: string;
  followers: string | null;
  followersPlatform: string | null;
  engagement: string | null;
  engagementPlatform: string | null;
  platforms: PlatformInfo[];
  location: string;
  collaborationType: string;
  offerDetails: string;
  avatarColor: string;
  avatarUrl: string | null | undefined;
  initials: string;
  isReceived: boolean;
  status: string;
}
