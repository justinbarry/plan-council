# Operator Follow-up

The human operator posted the following question or instruction:
{{{userMessage}}}
{{#if roundtable}}

You are answering {{roundtable.speaker}} of {{roundtable.total}}. Peers who already answered appear below: build on or contest their points instead of repeating them.
{{/if}}
{{#if peerUpdates}}

### Peers so far
{{#each peerUpdates}}
---
**{{reviewerLabel}}**:
{{{updateText}}}

{{/each}}
{{/if}}

{{#if peerItems}}
---
### Peer required revisions
{{#each peerItems}}
- `{{id}}`: {{{summary}}}
{{/each}}

{{/if}}
Reply like a comment in a review thread: direct and grounded in the plan under review, addressing peers by `@model` where you build on or contest them, with no section headers.
If your verdict or required revisions changed, or peer IDs are listed above, call `report_position` after your answer.
