# Council Debate: Round {{round}}

Peer reviewers have reviewed the plan. Examine their assessments below:

{{#each peerCritiques}}
---
### Critique from {{reviewerLabel}}
{{{critiqueText}}}

{{/each}}
{{#if operatorNotes}}
---
### Operator Guidance
{{{operatorNotes}}}

{{/if}}
{{#if peerItems}}
---
### Peer required revisions
{{#each peerItems}}
- `{{id}}`: {{{summary}}}
{{/each}}

{{/if}}
---
### Instructions for Rebuttal
1. Compare your earlier review with the peer critiques above.
2. Directly address disagreements: identify where a peer caught a genuine risk you missed, or where a peer's objection is mistaken or ungrounded.
3. Retract any of your own earlier objections if refuted or addressed.
4. Conclude with your updated assessment:
   - State whether your verdict is still `APPROVE`, `NEEDS REVISION`, or `BLOCK`.
   - List your finalized required plan revisions.
5. Call `report_position` with your updated verdict, your full current revision list, and a stance for every peer ID listed above.
