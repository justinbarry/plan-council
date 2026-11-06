# Operator Follow-up

The human operator posted the following question or instruction:
{{{userMessage}}}
{{#if peerUpdates}}

### Recent Peer Responses
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
Provide a direct, grounded response to the operator's inquiry in the context of the plan under review.
If your verdict or required revisions changed, or peer IDs are listed above, call `report_position` after your answer.
