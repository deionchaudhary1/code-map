// Lookups over a TopicSet, shared by the canvas, the legend and the side panel.
// A TopicSet is a list of topics each holding member ids; every consumer wants
// the inverse (which topic is this file in?) plus a stable color, so both are
// derived once here rather than re-scanned per frame.

import { colorForTopicIndex, UNASSIGNED_COLOR } from "./palette";
import type { TopicNode, TopicSet } from "./types";

export interface TopicView {
  topic: TopicNode;
  color: string;
  /** Position in the set — also what picks the color. */
  index: number;
}

export interface TopicIndex {
  views: TopicView[];
  byTopicId: Map<string, TopicView>;
  /** FileNode.id -> the topic it belongs to; absent for unassigned files. */
  byFileId: Map<string, TopicView>;
}

export function buildTopicIndex(set: TopicSet | null): TopicIndex | null {
  if (!set || set.topics.length === 0) return null;

  const views = set.topics.map((topic, index) => ({
    topic,
    index,
    color: colorForTopicIndex(index),
  }));

  const byTopicId = new Map(views.map((v) => [v.topic.id, v]));
  const byFileId = new Map<string, TopicView>();
  for (const view of views) {
    for (const member of view.topic.members) byFileId.set(member, view);
  }

  return { views, byTopicId, byFileId };
}

/** Border color for a file node while topic mode is on. */
export function topicColorForFile(index: TopicIndex, fileId: string): string {
  return index.byFileId.get(fileId)?.color ?? UNASSIGNED_COLOR;
}
