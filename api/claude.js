// Server-side proxy for Claude calls. The Anthropic key lives ONLY in the
// Vercel env var ANTHROPIC_API_KEY — never in the browser, repo, or Firestore.
// Model and max_tokens are fixed here, so callers can't run expensive models
// or long generations through this endpoint.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = 'claude-sonnet-4-5';
const TASKS = { parse: 400, ticker: 200 }; // task -> max_tokens
const MAX_PROMPT_CHARS = 8000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { task, prompt } = req.body || {};
  if (!TASKS[task]) return res.status(400).json({ error: 'Unknown task' });
  if (typeof prompt !== 'string' || !prompt || prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: TASKS[task],
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content.find(b => b.type === 'text')?.text || '';
    return res.status(200).json({ text });
  } catch (e) {
    const status = e instanceof Anthropic.APIError && e.status ? e.status : 500;
    console.error('Claude proxy error:', status, e.message);
    return res.status(status === 429 ? 429 : 502).json({ error: 'AI service error' });
  }
}
