// Groups every file in the graph into 4-5 named topics with one LLM call.
//
// Assignment is by *index*, not by path: the prompt numbers the files and the
// model answers with arrays of integers. That keeps the response short enough
// to fit a modest num_predict budget (a 200-file repo is ~600 tokens of indices
// versus ~4000 of paths, and a truncated reply is this feature's most likely
// failure), and it makes hallucinated files impossible — an index outside the
// range is simply dropped.

import type { FileGraph, TopicNode, TopicSet } from "../types.js";
import { generate } from "./ollama.js";

export const TOPIC_SYSTEM_PROMPT = [
  "You group the files of a software codebase into a small number of high-level topics.",
  "You are given a numbered list of files with their exported symbols and import counts.",
  "Reply with JSON only — no prose, no markdown fence.",
  'Shape: {"topics":[{"name":"...","summary":"...","files":[0,3,7]}]}',
  "Produce exactly 4 or 5 topics.",
  "A topic name is at most 3 words and names what the code *does*",
  '(for example "Static analysis", "HTTP server", "Web UI"), not where it lives.',
  "A summary is 1-2 plain sentences describing that part of the codebase.",
  "Every file index must appear in exactly one topic. Use only the indices you were given.",
  "Do not omit any index — a file you find hard to place still belongs to the topic it serves.",
].join(" ");

/** Output tokens reserved for the reply. 300 (the default elsewhere) truncates
 * the assignment arrays on any repo above roughly 40 files. */
export const TOPIC_NUM_PREDICT = 1500;

/** Above this, the prompt stops fitting comfortably in an 8B model's context,
 * so only the best-connected files are clustered and the rest go unassigned. */
const MAX_FILES_IN_PROMPT = 500;

const MIN_TOPICS = 2;
const MAX_TOPICS = 5;

export interface TopicPrompt {
  prompt: string;
  /** Index -> FileNode.id. The parser needs this to read the model's reply. */
  files: string[];
}

/** One line per file: enough signal to judge purpose, no source code. */
function describeFile(graph: FileGraph, id: string, index: number): string {
  const node = graph.nodes.find((n) => n.id === id)!;
  const inbound = graph.edges.filter((e) => e.target === id).length;
  const outbound = graph.edges.filter((e) => e.source === id).length;
  const exports = node.exports.slice(0, 6).join(", ") || "none";
  const flags = [node.isEntryPoint ? "entry" : "", inbound === 0 ? "unimported" : ""]
    .filter(Boolean)
    .join(" ");
  return `${index}\t${id}\texports: ${exports}\tin:${inbound} out:${outbound}${flags ? ` ${flags}` : ""}`;
}

export function buildTopicPrompt(graph: FileGraph): TopicPrompt {
  // Degree is the cheapest available proxy for "matters to the architecture",
  // and it is what decides who survives the cap on very large repos.
  const degree = new Map<string, number>();
  for (const node of graph.nodes) degree.set(node.id, 0);
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const ranked = [...graph.nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, MAX_FILES_IN_PROMPT)
    // Path order reads far better in the prompt than degree order, and the
    // model groups neighbours more consistently when siblings are adjacent.
    .sort((a, b) => a.id.localeCompare(b.id));

  const files = ranked.map((n) => n.id);
  const prompt = [
    `This codebase has ${graph.stats.fileCount} source files, ${graph.stats.edgeCount} imports`,
    `and ${graph.stats.apiCallCount} outbound HTTP calls.`,
    files.length < graph.nodes.length
      ? `The ${files.length} most connected files are listed below.`
      : "Every file is listed below.",
    "",
    "index\tpath\texports\timport counts",
    ...files.map((id, i) => describeFile(graph, id, i)),
    "",
    `Group these ${files.length} files into 4 or 5 topics. Reply with JSON only.`,
  ].join("\n");

  return { prompt, files };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "topic";
}

/** Models wrap JSON in prose or a fence even when told not to; take the
 * outermost braces rather than trusting the reply to be bare JSON. */
function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

interface RawTopic {
  name?: unknown;
  summary?: unknown;
  files?: unknown;
}

/**
 * Turns a model reply into a TopicSet, or explains why it could not.
 * Everything here is defensive: the input is untrusted model output.
 */
export function parseTopicSet(
  raw: string,
  files: string[],
  model: string,
  allIds: string[] = files,
): TopicSet | { error: string } {
  const json = extractJson(raw);
  if (!json) return { error: "The model did not return any JSON." };

  let parsed: { topics?: unknown };
  try {
    parsed = JSON.parse(json) as { topics?: unknown };
  } catch {
    return {
      error: "The model returned malformed JSON — it may have run out of output tokens.",
    };
  }

  const rawTopics = Array.isArray(parsed.topics) ? (parsed.topics as RawTopic[]) : null;
  if (!rawTopics) return { error: 'The model\'s reply had no "topics" array.' };

  // First writer wins, so a file the model listed twice lands in one topic.
  const claimed = new Set<number>();
  const topics: TopicNode[] = [];
  const usedIds = new Set<string>();

  for (const entry of rawTopics) {
    if (typeof entry?.name !== "string" || !entry.name.trim()) continue;
    const indices = Array.isArray(entry.files) ? entry.files : [];
    const members: string[] = [];
    for (const value of indices) {
      const index = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(index) || index < 0 || index >= files.length) continue;
      if (claimed.has(index)) continue;
      claimed.add(index);
      members.push(files[index]);
    }
    if (members.length === 0) continue;

    const name = entry.name.trim();
    let id = `topic::${slugify(name)}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `topic::${slugify(name)}-${suffix++}`;
    usedIds.add(id);

    topics.push({
      id,
      name,
      summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
      members,
    });
  }

  if (topics.length < MIN_TOPICS) {
    return { error: `The model produced ${topics.length} usable topic(s); expected 4-5.` };
  }

  // Over-production is common and recoverable: keep the largest topics and let
  // the stragglers fall through to unassigned rather than inventing a 6th group.
  topics.sort((a, b) => b.members.length - a.members.length);
  const kept = topics.slice(0, MAX_TOPICS);
  const keptMembers = new Set(kept.flatMap((t) => t.members));
  const unassigned = allIds.filter((id) => !keptMembers.has(id));

  return { topics: kept, model, generatedAt: new Date().toISOString(), unassigned };
}

/**
 * Places files the model skipped into the topic most of their import
 * neighbours already belong to.
 *
 * This exists because the model reliably drops 20-30% of files — on this repo's
 * own graph it left `web/src/layout/*`, `graphModel.ts` and `cli.ts` unplaced —
 * and a third of the canvas rendered neutral makes the grouping useless. Import
 * adjacency is the strongest signal available without asking the model again,
 * and it is deterministic, so the same reply always yields the same picture.
 *
 * Passes repeat because a file's only neighbour may itself have been backfilled
 * a moment ago. Files with no placed neighbour at all (config files, isolated
 * entry points) stay unassigned, which is the honest answer for them.
 */
export function backfillUnassigned(set: TopicSet, graph: FileGraph): TopicSet {
  if (set.unassigned.length === 0) return set;

  const topicOf = new Map<string, string>();
  for (const topic of set.topics) {
    for (const member of topic.members) topicOf.set(member, topic.id);
  }

  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!neighbors.has(edge.source)) neighbors.set(edge.source, []);
    if (!neighbors.has(edge.target)) neighbors.set(edge.target, []);
    neighbors.get(edge.source)!.push(edge.target);
    neighbors.get(edge.target)!.push(edge.source);
  }

  const added = new Map<string, string[]>();
  let pending = [...set.unassigned];

  for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
    const stillPending: string[] = [];
    let placedThisPass = 0;

    for (const id of pending) {
      const votes = new Map<string, number>();
      for (const neighbor of neighbors.get(id) ?? []) {
        const topicId = topicOf.get(neighbor);
        if (topicId) votes.set(topicId, (votes.get(topicId) ?? 0) + 1);
      }
      if (votes.size === 0) {
        stillPending.push(id);
        continue;
      }
      // Ties resolve by topic order, which is size-descending — the larger
      // topic wins, matching how a reader would guess.
      let best = "";
      let bestVotes = 0;
      for (const topic of set.topics) {
        const count = votes.get(topic.id) ?? 0;
        if (count > bestVotes) {
          best = topic.id;
          bestVotes = count;
        }
      }
      topicOf.set(id, best);
      if (!added.has(best)) added.set(best, []);
      added.get(best)!.push(id);
      placedThisPass++;
    }

    pending = stillPending;
    if (placedThisPass === 0) break;
  }

  return {
    ...set,
    topics: set.topics.map((topic) => ({
      ...topic,
      members: [...topic.members, ...(added.get(topic.id) ?? [])],
    })),
    unassigned: pending,
  };
}

/** Cache key is the model plus the file set — a different graph must not reuse
 * another graph's topics. */
const cache = new Map<string, TopicSet>();

export function clearTopicCache(): void {
  cache.clear();
}

export async function topicsFor(
  graph: FileGraph,
  model: string,
): Promise<TopicSet | { error: string }> {
  const { prompt, files } = buildTopicPrompt(graph);
  const key = `${model}::${files.length}::${files.join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const raw = await generate({
    model,
    prompt,
    system: TOPIC_SYSTEM_PROMPT,
    format: "json",
    numPredict: TOPIC_NUM_PREDICT,
  });

  const parsed = parseTopicSet(
    raw,
    files,
    model,
    graph.nodes.map((n) => n.id),
  );
  if ("error" in parsed) return parsed;

  const result = backfillUnassigned(parsed, graph);
  cache.set(key, result);
  return result;
}
