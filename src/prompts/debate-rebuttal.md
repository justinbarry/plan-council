# Council Debate: Round {{round}}

{{#if roundtable}}
You have the floor (turn {{roundtable.speaker}}{{#if roundtable.peerHandlesText}}; peers: {{roundtable.peerHandlesText}}{{/if}}). Reply directly to your peers rather than rewriting a standalone review.

{{#if moderator}}
### Moderator
{{#if moderator.topicId}}
Topic {{moderator.topicId}} · {{{moderator.topicTitle}}}
{{/if}}
{{{moderator.question}}}
Answer this first, then anything else still open for you.

{{/if}}
{{else if peerCritiques}}
Peer reviewers have reviewed the plan. Examine their assessments below:

{{/if}}
{{#each peerCritiques}}
---
{{#if isFollowupTurn}}
### Round {{turnRound}} {{turnKind}} from {{reviewerLabel}}
{{else}}
### Critique from {{reviewerLabel}}
{{/if}}
{{{critiqueText}}}

{{/each}}
{{#if operatorNotes}}
---
### Operator Guidance
{{{operatorNotes}}}

{{/if}}
{{#if ownDisputes}}
---
### Peer challenges to your revisions
{{#each ownDisputes}}
- **{{by}}** challenged your `{{id}}` ({{{summary}}}){{#if reason}}: {{{reason}}}{{/if}}
{{/each}}

{{/if}}
{{#if peerItemGroups}}
---
### Peer required revisions
{{#each peerItemGroups}}
{{#if heading}}
**{{{heading}}}**{{#if sameChange}} (moderator: these may be the same change; if they are, keep one wording by agreeing with a peer's item and dropping yours; if they differ, say how){{/if}}
{{/if}}
{{#each items}}
- `{{id}}`: {{{summary}}}
{{#each disputes}}
  - Disputed by **{{by}}**{{#if reason}}: {{{reason}}}{{/if}}
{{/each}}
{{/each}}
{{/each}}

{{/if}}
---
{{#if roundtable}}
### Roundtable Instructions
1. Address peers directly by `@model` handle and revision ID (`provider/model#N`).
2. Focus only on open disagreements, peer challenges to your revisions, and new points; do not repeat the `### Verdict`, `### Blocking Issues`, or `### Concrete Improvements` headers.{{#if hasCodeReader}} When peers dispute existing file contents, signatures, or callsites, verify the code with `ask_codebase` instead of speculating.{{/if}}
3. For each of your revisions under `### Peer challenges to your revisions`, defend it with file/line evidence, narrow it, or retract it.
4. Keep it short: one or two sentences when everything remaining is agreed. To ask a specific peer to answer next, set `nextSpeaker` on `report_position` to their `@model` handle.
5. End with `report_position`. `revisions` lists your complete standing set of still-required revisions: reuse unchanged `summary` strings verbatim, update narrowed summaries, and omit retracted ones; answer challenges to your own revisions here, not in `positions`. `positions` covers only the IDs listed under `### Peer required revisions` (empty when none are listed there).
6. If your stance depends on the operator's intent or scope, set `questionForOperator` and keep your stance provisional rather than disputing on assumptions.
{{else}}
### Instructions for Rebuttal
1. Compare your earlier review with the peer critiques above.
2. Directly address disagreements: identify where a peer caught a genuine risk you missed, or where a peer's objection is mistaken or ungrounded.{{#if hasCodeReader}} When peers dispute existing file contents, signatures, or callsites, verify the code with `ask_codebase` instead of speculating.{{/if}}
3. Retract any of your own earlier objections if refuted or addressed.
4. Conclude with your updated assessment:
   - State whether your verdict is still `APPROVE`, `NEEDS REVISION`, or `BLOCK`.
   - List your finalized required plan revisions.
5. Call `report_position` with your updated verdict, your complete standing set of still-required revisions (reusing unchanged `summary` strings verbatim), and a stance only for the IDs listed under `### Peer required revisions` (empty when none are listed there).
{{/if}}
