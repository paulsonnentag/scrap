import type {
  Candidate,
  CompiledProfile,
  KeyStatus,
  Match,
  MatchStatus,
  ScanSummary,
  SiteOverrideMode,
  UserProfile,
} from "./types";

/** Content → Background */
export interface GetActiveProfilesMsg {
  type: "GET_ACTIVE_PROFILES";
  url: string;
  title: string;
  summary: string;
  noStore: boolean;
}
export interface CandidatesMsg {
  type: "CANDIDATES";
  url: string;
  title: string;
  lang: string;
  candidates: Candidate[];
}

/** Background → Content */
export interface ActiveProfilesMsg {
  type: "ACTIVE_PROFILES";
  profiles: CompiledProfile[];
  skipped?: string;
}
export interface ResultsMsg {
  type: "RESULTS";
  url: string;
  matches: Array<{ id: string; profileId: string; domPath?: string; status: MatchStatus }>;
}
export interface FocusMatchMsg {
  type: "FOCUS_MATCH";
  matchId: string;
  domPath?: string;
}
export interface RescanContentMsg {
  type: "RESCAN_CONTENT";
  /** When present, only these profiles are run (used by TEST_PROFILE). */
  profiles?: CompiledProfile[];
}

/** Side panel → Background */
export interface GetPageMsg {
  type: "GET_PAGE";
  tabId: number;
}
export interface RescanMsg {
  type: "RESCAN";
  tabId: number;
}
export interface ReviewMsg {
  type: "REVIEW";
  matchId: string;
  origin: string;
  url: string;
  decision: "confirmed" | "rejected";
}
export interface SiteOverrideMsg {
  type: "SITE_OVERRIDE";
  profileId: string;
  origin: string;
  mode: SiteOverrideMode | null;
}
export interface CompileProfileMsg {
  type: "COMPILE_PROFILE";
  profile: UserProfile;
}
export interface TestProfileMsg {
  type: "TEST_PROFILE";
  compiled: CompiledProfile;
  tabId: number;
}
export interface SetKeyMsg {
  type: "SET_KEY";
  key: string;
}
export interface GetKeyStatusMsg {
  type: "GET_KEY_STATUS";
}
export interface GetProfilesMsg {
  type: "GET_PROFILES";
}
export interface SaveProfileMsg {
  type: "SAVE_PROFILE";
  profile: CompiledProfile;
}
export interface DeleteProfileMsg {
  type: "DELETE_PROFILE";
  profileId: string;
}
export interface ToggleProfileMsg {
  type: "TOGGLE_PROFILE";
  profileId: string;
  enabled: boolean;
}
export interface GetSettingsMsg {
  type: "GET_SETTINGS";
}
export interface SetSettingsMsg {
  type: "SET_SETTINGS";
  patch: Record<string, unknown>;
}
export interface GetSpendMsg {
  type: "GET_SPEND";
}
export interface GetDataIndexMsg {
  type: "GET_DATA_INDEX";
}
export interface GetOriginDocMsg {
  type: "GET_ORIGIN_DOC";
  origin: string;
}
export interface ClearSiteMsg {
  type: "CLEAR_SITE";
  origin: string;
}
export interface ClearAllMsg {
  type: "CLEAR_ALL";
}
export interface AskDecisionMsg {
  type: "ASK_DECISION";
  profileId: string;
  origin: string;
  allow: boolean;
  tabId: number;
}

/** Background → Side panel (pushed) */
export interface PageMsg {
  type: "PAGE";
  tabId: number;
  url: string;
  matches: Match[];
  summary?: ScanSummary;
}
export interface CompiledMsg {
  type: "COMPILED";
  compiled: CompiledProfile;
  warnings: string[];
}
export interface KeyStatusMsg {
  type: "KEY_STATUS";
  status: KeyStatus;
}
export interface AskProfileMsg {
  type: "ASK_PROFILE";
  profileId: string;
  profileName: string;
  origin: string;
  tabId: number;
}

export type ContentToBackground = GetActiveProfilesMsg | CandidatesMsg;
export type BackgroundToContent = ResultsMsg | FocusMatchMsg | RescanContentMsg;
export type PanelToBackground =
  | GetPageMsg
  | RescanMsg
  | ReviewMsg
  | SiteOverrideMsg
  | CompileProfileMsg
  | TestProfileMsg
  | SetKeyMsg
  | GetKeyStatusMsg
  | GetProfilesMsg
  | SaveProfileMsg
  | DeleteProfileMsg
  | ToggleProfileMsg
  | GetSettingsMsg
  | SetSettingsMsg
  | GetSpendMsg
  | GetDataIndexMsg
  | GetOriginDocMsg
  | ClearSiteMsg
  | ClearAllMsg
  | AskDecisionMsg;
export type BackgroundToPanel = PageMsg | CompiledMsg | KeyStatusMsg | AskProfileMsg;

export type AnyMessage = ContentToBackground | BackgroundToContent | PanelToBackground | BackgroundToPanel | ActiveProfilesMsg;

export function sendToBackground<T = unknown>(msg: ContentToBackground | PanelToBackground): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function sendToTab<T = unknown>(tabId: number, msg: BackgroundToContent): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}

/** Broadcast to extension pages (side panel). Errors when no listener exists are swallowed. */
export async function broadcast(msg: BackgroundToPanel): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // No side panel open; that's fine.
  }
}
