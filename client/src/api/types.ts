export type Role = 'admin' | 'voter';

export interface User {
  id: string;
  email: string;
  role: Role;
  mfaEnabled: boolean;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
  mfaEnrollmentRequired: boolean;
}

export type EventStatus = 'draft' | 'open' | 'closed';
export type ResultsVisibility = 'live' | 'afterClose';

export interface VotingEvent {
  id: string;
  title: string;
  description: string;
  status: EventStatus;
  startsAt: string;
  endsAt: string;
  resultsVisibility: ResultsVisibility;
  votingOpen: boolean;
  openedAt: string | null;
  closedAt: string | null;
}

export interface Candidate {
  id: string;
  eventId: string;
  name: string;
  team: string;
  bio: string;
  imageUrl: string | null;
}

export interface EventDetail extends VotingEvent {
  candidates: Candidate[];
}

export interface VoterEvent extends VotingEvent {
  hasVoted: boolean;
}

export interface CandidateResult {
  id: string;
  name: string;
  team: string;
  imageUrl: string | null;
  /** null while results are hidden until close */
  votes: number | null;
  percent: number | null;
}

export interface ResultsSnapshot {
  eventId: string;
  title: string;
  status: 'open' | 'closed';
  votingOpen: boolean;
  endsAt: string;
  resultsVisible: boolean;
  final: boolean;
  totalVotes: number;
  turnout: { eligible: number; registered: number; voted: number; percent: number };
  candidates: CandidateResult[];
  updatedAt: string;
}
