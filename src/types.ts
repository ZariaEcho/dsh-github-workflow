/**
 * GitHub REST API shapes used by the toolset (structural, non-exhaustive).
 *
 * Kept separate from the client so type consumers (tools, renderers) do not
 * pull in the fetch/transport module.
 *
 * @module dsh-github-workflow/types
 */

export interface GitHubUser {
  login: string
}

export interface GitHubLabel {
  name: string
}

export interface GitHubIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  state_reason?: string
  body: string | null
  user: GitHubUser | null
  labels: GitHubLabel[]
  milestone: { title: string } | null
  created_at: string
  updated_at: string
  comments: number
  html_url: string
  /** Present when the "issue" is actually a pull request. */
  pull_request?: { url: string; merged_at: string | null }
}

export interface GitHubComment {
  id: number
  user: GitHubUser | null
  body: string
  created_at: string
  html_url: string
}

export interface GitHubRepo {
  full_name: string
  description: string | null
  default_branch: string
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  archived: boolean
  topics: string[]
  html_url: string
}

export interface GitHubPullRequest {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  body: string | null
  html_url: string
  user: GitHubUser | null
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; sha: string }
  created_at: string
  updated_at: string
  merged_at: string | null
  additions: number
  deletions: number
  changed_files: number
  mergeable: boolean | null
  /** `clean` / `blocked` / `behind` / `dirty` / `draft` / `unstable` / `unknown`. */
  mergeable_state: string
}

export interface GitHubPullRequestFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  raw_url: string
}

export interface GitHubCommit {
  sha: string
  commit: { message: string; author: { date: string } }
  author: GitHubUser | null
}

export interface GitHubCompare {
  status: string
  ahead_by: number
  behind_by: number
  commits: GitHubCommit[]
  files: GitHubPullRequestFile[]
}

export interface GitHubStatuses {
  state: 'success' | 'failure' | 'pending' | 'error'
  total_count: number
  statuses: Array<{
    context: string
    state: 'success' | 'failure' | 'pending' | 'error'
    target_url: string | null
    description: string | null
    created_at: string
  }>
}

export interface GitHubCheckRun {
  /** Present for real check runs; absent for legacy statuses folded in. */
  id?: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  details_url: string
  started_at: string | null
  completed_at: string | null
}

export interface GitHubCheckRuns {
  total_count: number
  check_runs: GitHubCheckRun[]
}

export interface GitHubSearchResult {
  total_count: number
  items: Array<{
    number: number
    title: string
    state: 'open' | 'closed'
    html_url: string
    created_at: string
    updated_at: string
    comments: number
    user: GitHubUser | null
    labels: GitHubLabel[]
    pull_request?: { merged_at: string | null }
  }>
}

export interface GitHubCreatedPullRequest {
  number: number
  html_url: string
  title: string
  draft: boolean
  head: { ref: string }
  base: { ref: string }
}

export interface GitHubReview {
  id: number
  html_url: string
  state: string
  body: string | null
  submitted_at: string
  user: GitHubUser | null
}

/** One pull request review comment (thread node on the REST wire). */
export interface GitHubReviewComment {
  id: number
  body: string
  path: string
  line: number | null
  user: GitHubUser | null
  created_at: string
  in_reply_to_id: number | null
  html_url: string
}

/** One check-run annotation. */
export interface GitHubAnnotation {
  path: string
  start_line: number | null
  end_line: number | null
  message: string
  annotation_level: string
}

/** Branch protection summary (subset of the API shape). */
export interface GitHubBranchProtection {
  required_pull_request_reviews?: {
    required_approving_review_count?: number
    dismiss_stale_reviews?: boolean
  }
  required_status_checks?: {
    contexts: string[]
    strict?: boolean
  }
  enforce_admins?: { enabled: boolean }
  required_linear_history?: { enabled: boolean }
  allow_force_pushes?: { enabled: boolean }
  allow_deletions?: { enabled: boolean }
  restrictions?: unknown | null
}

/** Result of `POST /pulls/{n}/merge`. */
export interface GitHubMergeResult {
  sha: string
  merged: boolean
  message: string
}

/** Result of `POST /pulls/{n}/requested_reviewers`. */
export interface GitHubRequestedReviewers {
  reviewers: Array<{ login: string }>
}

/** One paginated list plus whether the caller-imposed cap was reached. */
export interface Paged<T> {
  items: T[]
  /** True when the page loop stopped at the cap with a full last page. */
  truncated: boolean
}
