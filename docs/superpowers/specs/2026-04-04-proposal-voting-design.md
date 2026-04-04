# TLD Proposal Voting (Reddit-style)

## Summary

Add Reddit-style up/down voting to open TLD proposals. A monthly cron job auto-approves the top 5 proposals by net score.

## Data Model

### Vote (new collection)

```typescript
interface IVote {
  proposal: ObjectId;  // ref TLDProposal
  user: ObjectId;      // ref User
  direction: "up" | "down";
  createdAt: Date;
  updatedAt: Date;
}
```

- Unique compound index on `(proposal, user)` — one vote per user per proposal.
- Timestamps enabled.

### TLDProposal changes

- Remove the `votes: number` field.
- Score is computed via aggregation at query time (upvotes - downvotes), not stored.

## API Endpoints

### `POST /tlds/proposals/:id/vote`

- Auth required.
- Body: `{ direction: "up" | "down" }`.
- Validates proposal exists and is "open".
- Rejects if the authenticated user is the proposer (403).
- Upserts: creates a new vote or updates direction if vote already exists.
- Returns the updated score and the user's current vote direction.

### `DELETE /tlds/proposals/:id/vote`

- Auth required.
- Removes the user's vote on the proposal.
- Returns the updated score.

### `GET /tlds/proposals` (updated)

- Aggregates score (upvotes - downvotes) for each proposal.
- If the request includes an auth token, includes `userVote: "up" | "down" | null` per proposal.
- Sorted by score descending, then createdAt descending.

## Monthly Cron Job

Runs on the 1st of each month (e.g., `0 0 1 * *`).

1. Aggregate net score for all open proposals.
2. Filter to proposals with score > 0.
3. Take the top 5 by score (ties broken by createdAt ascending — older proposal wins).
4. For each winner:
   - Set proposal status to "approved".
   - Set the corresponding TLD document status to "active".
5. Log results.

Implementation: a standalone script invoked by system cron or a process scheduler. Not an in-process timer.

## Frontend

### Proposal list (Propose.tsx)

Each open proposal card gets:

- Up arrow button (highlighted if user voted up).
- Score number between arrows.
- Down arrow button (highlighted if user voted down).
- Clicking an already-active arrow removes the vote (toggle behavior).
- Arrows disabled/hidden for:
  - Unauthenticated users (show score only).
  - The proposal's own author.
  - Non-open proposals.

### Optimistic updates

- Update score and highlight state immediately on click.
- Revert on API error.

## Constraints

- Users cannot vote on their own proposals.
- Only open proposals are votable.
- One vote per user per proposal (enforced by unique index).
- Proposals with score <= 0 are never auto-approved regardless of rank.
