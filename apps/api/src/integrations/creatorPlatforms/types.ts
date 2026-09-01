export const CREATOR_PLATFORM_PROVIDERS = ["instagram", "facebook", "tiktok", "youtube"] as const;

export type CreatorPlatformProvider = (typeof CREATOR_PLATFORM_PROVIDERS)[number];

export type CreatorPlatformUnavailableReason =
  "not_supported" | "not_returned" | "privacy_threshold" | "missing_permission" | "no_data";

export type CreatorPlatformMetric<T> =
  | { value: T; unavailableReason?: never }
  | { value: null; unavailableReason: CreatorPlatformUnavailableReason };

export type CreatorPlatformImportWindow = {
  startDate: string;
  endDate: string;
};

export type CreatorPlatformAccount = {
  provider: CreatorPlatformProvider;
  providerAccountId: string;
  displayName: string;
  username?: string;
  profileUrl?: string;
  avatarUrl?: string;
  accountType: "professional" | "page" | "profile" | "channel";
};

type BaseGrant = {
  accessToken: string;
  expiresAt?: string;
  scopes: string[];
};

export type InstagramCreatorPlatformGrant = BaseGrant & { provider: "instagram" };

export type FacebookCreatorPlatformGrant = BaseGrant & {
  provider: "facebook";
  subjectId?: string;
  pageAccessTokens: Record<string, string>;
};

export type TikTokCreatorPlatformGrant = BaseGrant & {
  provider: "tiktok";
  openId: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

export type YouTubeCreatorPlatformGrant = BaseGrant & {
  provider: "youtube";
  refreshToken?: string;
};

export type CreatorPlatformGrant =
  | InstagramCreatorPlatformGrant
  | FacebookCreatorPlatformGrant
  | TikTokCreatorPlatformGrant
  | YouTubeCreatorPlatformGrant;

export type CreatorPlatformAccountList = {
  accounts: CreatorPlatformAccount[];
  grant: CreatorPlatformGrant;
};

export type CreatorPlatformAudience = {
  countries: CreatorPlatformMetric<Record<string, number>>;
  ageGroups: CreatorPlatformMetric<Record<string, number>>;
  genders: CreatorPlatformMetric<Record<string, number>>;
};

export type CreatorPlatformProviderMetrics = {
  totalLikes?: number;
  totalVideoCount?: number;
  dailyUniqueMediaViewsSum?: number;
};

export type CreatorPlatformImport = {
  provider: CreatorPlatformProvider;
  providerAccountId: string;
  importedAt: string;
  window: CreatorPlatformImportWindow;
  followers: CreatorPlatformMetric<number>;
  contentCount: CreatorPlatformMetric<number>;
  likes: CreatorPlatformMetric<number>;
  comments: CreatorPlatformMetric<number>;
  shares: CreatorPlatformMetric<number>;
  reach: CreatorPlatformMetric<number>;
  views: CreatorPlatformMetric<number>;
  demographics: CreatorPlatformAudience;
  providerMetrics?: CreatorPlatformProviderMetrics;
};

export interface CreatorPlatformAdapter {
  readonly provider: CreatorPlatformProvider;
  buildAuthorizationUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<CreatorPlatformGrant>;
  listAccounts(
    grant: CreatorPlatformGrant,
    signal?: AbortSignal,
  ): Promise<CreatorPlatformAccountList>;
  grantForAccount?(
    account: CreatorPlatformAccount,
    grant: CreatorPlatformGrant,
  ): CreatorPlatformGrant;
  refreshGrant?(grant: CreatorPlatformGrant, signal?: AbortSignal): Promise<CreatorPlatformGrant>;
  importAccount(
    account: CreatorPlatformAccount,
    grant: CreatorPlatformGrant,
    window: CreatorPlatformImportWindow,
    signal?: AbortSignal,
  ): Promise<CreatorPlatformImport>;
  revoke?(grant: CreatorPlatformGrant): Promise<void>;
}

export type CreatorPlatformAdapterRuntime = {
  fetch?: typeof fetch;
  now?: () => Date;
};
