# TLD Proposal Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Reddit-style up/down voting to TLD proposals with a monthly cron that auto-approves the top 5.

**Architecture:** New Vote model with compound unique index `(proposal, user)`. Voting endpoints on the existing tlds router. Proposals endpoint updated to aggregate scores via MongoDB pipeline. Standalone cron script for monthly auto-approval.

**Tech Stack:** Mongoose 9.3, Express 5.2, React 19, TailwindCSS 4.2

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `apps/api/src/models/Vote.ts` | Vote document schema and TypeScript interface |
| Modify | `apps/api/src/models/TLDProposal.ts` | Remove `votes` field from schema and interface |
| Modify | `apps/api/src/routes/tlds.ts` | Add vote endpoints, update proposals listing with aggregation |
| Create | `apps/api/src/scripts/approve-top-proposals.ts` | Monthly cron script: approve top 5 open proposals |
| Modify | `apps/web/src/pages/Propose.tsx` | Vote arrows UI, optimistic updates, auth-aware state |

---

### Task 1: Create Vote Model

**Files:**
- Create: `apps/api/src/models/Vote.ts`

- [ ] **Step 1: Create the Vote model file**

```typescript
// apps/api/src/models/Vote.ts
import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IVote extends Document {
  _id: Types.ObjectId;
  proposal: Types.ObjectId;
  user: Types.ObjectId;
  direction: "up" | "down";
  createdAt: Date;
  updatedAt: Date;
}

const VoteSchema = new Schema<IVote>(
  {
    proposal: {
      type: Schema.Types.ObjectId,
      ref: "TLDProposal",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    direction: {
      type: String,
      enum: ["up", "down"],
      required: true,
    },
  },
  { timestamps: true }
);

VoteSchema.index({ proposal: 1, user: 1 }, { unique: true });

export default mongoose.model<IVote>("Vote", VoteSchema);
```

- [ ] **Step 2: Verify the API compiles**

Run: `cd apps/api && bun run build`
Expected: Compiles with no errors. The model is auto-registered by Mongoose on import.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/models/Vote.ts
git commit -m "feat: add Vote model for proposal up/down voting"
```

---

### Task 2: Remove `votes` Field from TLDProposal

**Files:**
- Modify: `apps/api/src/models/TLDProposal.ts`

- [ ] **Step 1: Remove `votes` from the interface and schema**

In `apps/api/src/models/TLDProposal.ts`:

Remove `votes: number;` from the `ITLDProposal` interface.

Remove this block from the schema definition:
```typescript
    votes: {
      type: Number,
      default: 0,
    },
```

The resulting interface should be:
```typescript
export interface ITLDProposal extends Document {
  _id: Types.ObjectId;
  tld: string;
  proposedBy: Types.ObjectId;
  reason: string;
  status: "open" | "approved" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 2: Verify the API compiles**

Run: `cd apps/api && bun run build`
Expected: May show errors in `routes/tlds.ts` referencing `votes` — that's expected, we fix it in Task 3.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/models/TLDProposal.ts
git commit -m "refactor: remove denormalized votes field from TLDProposal"
```

---

### Task 3: Add Vote Endpoints and Update Proposals Listing

**Files:**
- Modify: `apps/api/src/routes/tlds.ts`

- [ ] **Step 1: Add Vote import and the `findOrCreateUser` helper is already present**

At the top of `apps/api/src/routes/tlds.ts`, add the Vote import alongside the existing imports:

```typescript
import Vote from "../models/Vote.js";
```

- [ ] **Step 2: Add POST /tlds/proposals/:id/vote endpoint**

Add before the `export default router;` line:

```typescript
// POST /tlds/proposals/:id/vote -- upvote or downvote (auth required)
router.post("/proposals/:id/vote", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { direction } = req.body;

    if (direction !== "up" && direction !== "down") {
      res.status(400).json({ error: "direction must be 'up' or 'down'" });
      return;
    }

    const proposal = await TLDProposal.findById(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    if (proposal.status !== "open") {
      res.status(400).json({ error: "Can only vote on open proposals" });
      return;
    }

    const oxyUserId = req.user!.id;
    const user = await findOrCreateUser(oxyUserId);

    if (proposal.proposedBy.equals(user._id)) {
      res.status(403).json({ error: "Cannot vote on your own proposal" });
      return;
    }

    await Vote.findOneAndUpdate(
      { proposal: proposal._id, user: user._id },
      { direction },
      { upsert: true }
    );

    const [counts] = await Vote.aggregate([
      { $match: { proposal: proposal._id } },
      {
        $group: {
          _id: null,
          up: { $sum: { $cond: [{ $eq: ["$direction", "up"] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ["$direction", "down"] }, 1, 0] } },
        },
      },
    ]);

    const score = counts ? counts.up - counts.down : 0;

    res.json({ score, userVote: direction });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: "Failed to vote" });
  }
});
```

- [ ] **Step 3: Add DELETE /tlds/proposals/:id/vote endpoint**

Add after the POST vote endpoint:

```typescript
// DELETE /tlds/proposals/:id/vote -- remove vote (auth required)
router.delete("/proposals/:id/vote", requireAuth, async (req: AuthRequest, res) => {
  try {
    const proposal = await TLDProposal.findById(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const oxyUserId = req.user!.id;
    const user = await findOrCreateUser(oxyUserId);

    await Vote.deleteOne({ proposal: proposal._id, user: user._id });

    const [counts] = await Vote.aggregate([
      { $match: { proposal: proposal._id } },
      {
        $group: {
          _id: null,
          up: { $sum: { $cond: [{ $eq: ["$direction", "up"] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ["$direction", "down"] }, 1, 0] } },
        },
      },
    ]);

    const score = counts ? counts.up - counts.down : 0;

    res.json({ score, userVote: null });
  } catch (err) {
    console.error("Remove vote error:", err);
    res.status(500).json({ error: "Failed to remove vote" });
  }
});
```

- [ ] **Step 4: Rewrite GET /tlds/proposals to aggregate scores and include user vote**

Replace the existing `GET /tlds/proposals` handler with:

```typescript
// GET /tlds/proposals -- list all proposals with scores
router.get("/proposals", async (req: AuthRequest, res) => {
  try {
    let userId: mongoose.Types.ObjectId | null = null;
    if (req.user?.id) {
      const user = await User.findOne({ oxyUserId: req.user.id });
      if (user) userId = user._id;
    }

    const proposals = await TLDProposal.aggregate([
      {
        $lookup: {
          from: "votes",
          localField: "_id",
          foreignField: "proposal",
          as: "votesDocs",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "proposedBy",
          foreignField: "_id",
          as: "proposedByDoc",
        },
      },
      { $unwind: { path: "$proposedByDoc", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          score: {
            $subtract: [
              { $size: { $filter: { input: "$votesDocs", cond: { $eq: ["$$this.direction", "up"] } } } },
              { $size: { $filter: { input: "$votesDocs", cond: { $eq: ["$$this.direction", "down"] } } } },
            ],
          },
          userVote: userId
            ? {
                $let: {
                  vars: {
                    myVote: {
                      $arrayElemAt: [
                        { $filter: { input: "$votesDocs", cond: { $eq: ["$$this.user", userId] } } },
                        0,
                      ],
                    },
                  },
                  in: { $ifNull: ["$$myVote.direction", null] },
                },
              }
            : null,
          proposedBy: {
            _id: "$proposedByDoc._id",
            oxyUserId: "$proposedByDoc.oxyUserId",
          },
        },
      },
      { $project: { votesDocs: 0, proposedByDoc: 0 } },
      { $sort: { score: -1, createdAt: -1 } },
    ]);

    res.json(proposals);
  } catch (err) {
    console.error("List proposals error:", err);
    res.status(500).json({ error: "Failed to list proposals" });
  }
});
```

You also need to add the `mongoose` import at the top of the file for `mongoose.Types.ObjectId`:

The existing import `import TLDProposal from "../models/TLDProposal.js"` already brings in mongoose indirectly, but you need the `mongoose` namespace for the `Types.ObjectId` type. Add at the top:

```typescript
import mongoose from "mongoose";
```

- [ ] **Step 5: Verify the API compiles**

Run: `cd apps/api && bun run build`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tlds.ts
git commit -m "feat: add vote endpoints and aggregate scores in proposals listing"
```

---

### Task 4: Monthly Auto-Approval Cron Script

**Files:**
- Create: `apps/api/src/scripts/approve-top-proposals.ts`

- [ ] **Step 1: Create the cron script**

```typescript
// apps/api/src/scripts/approve-top-proposals.ts
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import TLDProposal from "../models/TLDProposal.js";
import TLD from "../models/TLD.js";
import Vote from "../models/Vote.js";

const APP_NAME = "tnp";
const env = process.env.NODE_ENV || "development";
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = `${APP_NAME}-${env}`;

async function approveTopProposals() {
  await mongoose.connect(mongoUri, { dbName });
  console.log(`Connected to MongoDB (${dbName})`);

  const ranked = await TLDProposal.aggregate([
    { $match: { status: "open" } },
    {
      $lookup: {
        from: "votes",
        localField: "_id",
        foreignField: "proposal",
        as: "votesDocs",
      },
    },
    {
      $addFields: {
        score: {
          $subtract: [
            { $size: { $filter: { input: "$votesDocs", cond: { $eq: ["$$this.direction", "up"] } } } },
            { $size: { $filter: { input: "$votesDocs", cond: { $eq: ["$$this.direction", "down"] } } } },
          ],
        },
      },
    },
    { $match: { score: { $gt: 0 } } },
    { $sort: { score: -1, createdAt: 1 } },
    { $limit: 5 },
    { $project: { _id: 1, tld: 1, score: 1 } },
  ]);

  if (ranked.length === 0) {
    console.log("No open proposals with positive score. Nothing to approve.");
    await mongoose.disconnect();
    return;
  }

  for (const entry of ranked) {
    await TLDProposal.updateOne(
      { _id: entry._id },
      { $set: { status: "approved" } }
    );
    await TLD.updateOne(
      { name: entry.tld },
      { $set: { status: "active" } }
    );
    console.log(`Approved .${entry.tld} (score: ${entry.score})`);
  }

  console.log(`Approved ${ranked.length} proposal(s).`);
  await mongoose.disconnect();
}

approveTopProposals().catch((err) => {
  console.error("Auto-approval failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script compiles**

Run: `cd apps/api && bun run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/scripts/approve-top-proposals.ts
git commit -m "feat: add monthly cron script to auto-approve top 5 proposals"
```

**Deployment note:** Add a system cron entry to run this on the 1st of each month:
```
0 0 1 * * cd /path/to/tnp && bun run apps/api/src/scripts/approve-top-proposals.ts
```

---

### Task 5: Frontend Vote UI

**Files:**
- Modify: `apps/web/src/pages/Propose.tsx`

- [ ] **Step 1: Update the Proposal interface**

In `apps/web/src/pages/Propose.tsx`, replace the existing `Proposal` interface:

```typescript
interface Proposal {
  _id: string;
  tld: string;
  reason: string;
  score: number;
  userVote: "up" | "down" | null;
  status: "open" | "approved" | "rejected";
  proposedBy: { _id: string; oxyUserId: string };
  createdAt: string;
}
```

- [ ] **Step 2: Add vote handler function**

Inside the `Propose` component, after the existing `handleSubmit` function, add:

```typescript
  const handleVote = async (proposalId: string, direction: "up" | "down") => {
    const proposal = proposals.find((p) => p._id === proposalId);
    if (!proposal) return;

    const isToggle = proposal.userVote === direction;

    // Optimistic update
    setProposals((prev) =>
      prev.map((p) => {
        if (p._id !== proposalId) return p;
        if (isToggle) {
          return {
            ...p,
            score: p.score + (direction === "up" ? -1 : 1),
            userVote: null,
          };
        }
        const scoreDelta =
          direction === "up"
            ? p.userVote === "down" ? 2 : 1
            : p.userVote === "up" ? -2 : -1;
        return { ...p, score: p.score + scoreDelta, userVote: direction };
      })
    );

    try {
      if (isToggle) {
        await apiFetch(`/tlds/proposals/${proposalId}/vote`, { method: "DELETE" });
      } else {
        await apiFetch(`/tlds/proposals/${proposalId}/vote`, {
          method: "POST",
          body: JSON.stringify({ direction }),
        });
      }
    } catch {
      // Revert on error
      const updated = await apiFetch<Proposal[]>("/tlds/proposals");
      setProposals(updated);
    }
  };
```

- [ ] **Step 3: Add the `user` destructure from `useAuth`**

Update the `useAuth` destructure at the top of the component:

```typescript
  const { isAuthenticated, signIn, user } = useAuth();
```

- [ ] **Step 4: Replace the proposal card rendering**

Replace the proposal card `<div>` inside the `.map()` (the one with `key={p._id}`) with:

```tsx
            <div
              key={p._id}
              className="flex items-center gap-4 rounded-lg border border-edge bg-surface-card p-4"
            >
              {p.status === "open" && isAuthenticated && user?.id !== p.proposedBy?.oxyUserId && (
                <div className="flex flex-col items-center gap-0.5">
                  <button
                    onClick={() => handleVote(p._id, "up")}
                    className={`cursor-pointer rounded p-1 transition-colors ${
                      p.userVote === "up"
                        ? "text-accent"
                        : "text-muted hover:text-primary"
                    }`}
                    aria-label="Upvote"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 4l-8 8h5v8h6v-8h5z" />
                    </svg>
                  </button>
                  <span className={`font-mono text-xs font-medium ${
                    p.score > 0 ? "text-accent" : p.score < 0 ? "text-red-400" : "text-muted"
                  }`}>
                    {p.score}
                  </span>
                  <button
                    onClick={() => handleVote(p._id, "down")}
                    className={`cursor-pointer rounded p-1 transition-colors ${
                      p.userVote === "down"
                        ? "text-red-400"
                        : "text-muted hover:text-primary"
                    }`}
                    aria-label="Downvote"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 20l8-8h-5V4H9v8H4z" />
                    </svg>
                  </button>
                </div>
              )}
              {(p.status !== "open" || !isAuthenticated || user?.id === p.proposedBy?.oxyUserId) && (
                <div className="flex flex-col items-center justify-center w-8">
                  <span className={`font-mono text-xs font-medium ${
                    p.score > 0 ? "text-accent" : p.score < 0 ? "text-red-400" : "text-muted"
                  }`}>
                    {p.score}
                  </span>
                </div>
              )}
              <div className="flex-1">
                <span className="font-mono text-accent">.{p.tld}</span>
                <p className="mt-1 font-mono text-xs text-muted">{p.reason}</p>
              </div>
              <span
                className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                  p.status === "open"
                    ? "bg-accent/10 text-accent"
                    : p.status === "approved"
                      ? "bg-green-500/10 text-green-400"
                      : "bg-red-500/10 text-red-400"
                }`}
              >
                {p.status}
              </span>
            </div>
```

- [ ] **Step 5: Remove the old `votes` reference**

The old interface had `votes: number` and the template showed `{p.votes} votes`. Both are now replaced by `score` and the vote arrows. Verify no remaining references to `p.votes` exist in the file.

- [ ] **Step 6: Verify the web app compiles**

Run: `cd apps/web && bun run build`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/Propose.tsx
git commit -m "feat: add vote arrows UI with optimistic updates to proposals page"
```

---

### Task 6: Manual Verification

- [ ] **Step 1: Start the dev servers**

Run: `bun run dev`

- [ ] **Step 2: Test the full flow**

1. Open `http://localhost:5173/propose`
2. Sign in, create a proposal — verify vote arrows do NOT appear on your own proposal
3. Open in a different browser/incognito, sign in as a different user
4. Upvote a proposal — arrow highlights, score increments
5. Click upvote again — vote removed (toggle), score decrements
6. Downvote — arrow highlights red, score decrements
7. Switch back to original browser — verify score reflects changes
8. Sign out — verify only score number shows, no arrows

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during manual verification"
```
