# Moderator: frame the next turn

Plan under review: {{{planTitle}}} (`{{{planFilePath}}}`)

Call `moderate_turn` once. Choose the next speaker from ### Queued speakers and ask them one question about one topic. If a revision under ### Placed provisionally belongs in a different or new topic, move it with `assignments`. List in `sameChangeTopicIds` any topic whose revisions are now genuinely equivalent versions of one change.

{{{snapshot}}}
{{#if provisional}}

### Placed provisionally
{{{provisional}}}
{{/if}}

### Turn that just ended: {{{turnLabel}}}
{{{turnText}}}
{{#if turnDelta}}

Position change: {{{turnDelta}}}
{{/if}}
