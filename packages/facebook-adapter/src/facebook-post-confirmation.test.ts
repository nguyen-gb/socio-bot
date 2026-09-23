import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskPostRequest, readPostConfirmation } from './facebook-post-confirmation';

const group = 'https://www.facebook.com/groups/123456/';
const request = (overrides: Record<string, unknown> = {}) => new URLSearchParams({ fb_api_req_friendly_name: 'ComposerStoryCreateMutation', variables: JSON.stringify({ input: { audience: { to_id: '123456' }, actor_id: 'fixture-user', message: { text: 'Test' }, ...overrides } }) }).toString();
const response = () => ({ data: { story_create: { post_id: null, publishing_flow: 'FALLBACK', story: { url: `${group}permalink/789/`, to: { id: '123456', url: group }, if_viewer_can_learn_more_about_pending_post: null, is_marked_as_spam_by_admin_assistant: false }, group_feed_story_edge: { node: { post_id: '789', comet_sections: { content: { story: { message: { text: 'Test' } } } } } } } } });

test('creation request must match task group, full text, actor and mutation', () => {
  assert.equal(isTaskPostRequest(request(), group, 'Test', 'fixture-user'), true);
  for (const input of [{ audience: { to_id: 'other' } }, { actor_id: 'other' }, { message: { text: 'Test changed' } }]) assert.equal(isTaskPostRequest(request(input), group, 'Test', 'fixture-user'), false);
  assert.equal(isTaskPostRequest(request().replace('ComposerStoryCreateMutation', 'OtherMutation'), group, 'Test', 'fixture-user'), false);
  assert.equal(isTaskPostRequest('not JSON', group, 'Test', 'fixture-user'), false);
});
test('observed Facebook FALLBACK response confirms public feed post despite null top-level post_id', () => {
  assert.deepEqual(readPostConfirmation(JSON.stringify(response()), group, 'Test'), { status: 'PUBLISHED', postUrl: `${group}permalink/789/` });
});
test('anti-JSON prefix and multiline envelopes are supported', () => {
  assert.equal(readPostConfirmation('for (;;);\n{}\n' + JSON.stringify(response()), group, 'Test')?.status, 'PUBLISHED');
});
test('pending response is not reported published', () => {
  const value = response();
  (value.data.story_create.story as Record<string, unknown>).if_viewer_can_learn_more_about_pending_post = { __typename: 'PendingPost' };
  assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test')?.status, 'PENDING_APPROVAL');
});
test('false pending flag is not a moderation renderer', () => {
  const value = response(); (value.data.story_create.story as Record<string, unknown>).if_viewer_can_learn_more_about_pending_post = false;
  assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test')?.status, 'PUBLISHED');
});
test('observed pending-participation response is pending despite a feed edge and permalink', () => {
  const value = response();
  (value.data.story_create.story.to as Record<string, unknown>).if_viewer_can_see_pending_content_card = {
    group_pending_action_card_renderer: { group: { if_viewer_can_see_pending_content_card: { pending_post_info: { pending_content_section_title: 'Pending admin approval', pending_content_section_body: '3 posts' } } } },
    if_viewer_cannot_add_pending_participation_content_in_forum: { id: '123456', comet_inline_composer_renderer: {} },
  };
  assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test')?.status, 'PENDING_APPROVAL');
});
test('scheduled creation is not immediate publication', () => {
  const value = response(); (value.data.story_create.story as Record<string, unknown>).scheduled_publish_time = 123456;
  assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test')?.status, 'REJECTED');
});
test('spam-held creation and GraphQL errors do not claim publication', () => {
  const value = response(); value.data.story_create.story.is_marked_as_spam_by_admin_assistant = true;
  assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test')?.status, 'REJECTED');
  assert.equal(readPostConfirmation(JSON.stringify({ ...response(), errors: [{ message: 'Rejected' }] }), group, 'Test')?.status, 'REJECTED');
});
test('wrong group, old-looking/mismatched message and absent feed node do not confirm', () => {
  const wrongGroup = response(); wrongGroup.data.story_create.story.to.id = '654321';
  const wrongText = response(); wrongText.data.story_create.group_feed_story_edge.node.comet_sections.content.story.message.text = 'Test changed';
  const wrongId = response(); wrongId.data.story_create.group_feed_story_edge.node.post_id = 'different';
  const noFeed = response(); (noFeed.data.story_create as Record<string, unknown>).group_feed_story_edge = null;
  for (const value of [wrongGroup, wrongText, wrongId, noFeed, {}, { data: {} }]) assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test'), undefined);
});
test('external, credentialed or wrong-group permalinks are rejected', () => {
  for (const url of ['https://evil.test/groups/123456/permalink/789/', 'https://www.facebook.com/groups/654321/permalink/789/', 'https://user:pass@www.facebook.com/groups/123456/permalink/789/', `${group}user/789/`]) {
    const value = response(); value.data.story_create.story.url = url;
    assert.equal(readPostConfirmation(JSON.stringify(value), group, 'Test'), undefined);
  }
});
test('malformed body and HTML HTTP 200 are never confirmation', () => {
  assert.equal(readPostConfirmation('<!DOCTYPE html>', group, 'Test'), undefined);
  assert.equal(readPostConfirmation('not JSON', group, 'Test'), undefined);
});
