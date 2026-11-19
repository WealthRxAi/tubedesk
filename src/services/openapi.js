// OpenAPI 3.1 description of the TubeDesk tools, for clients that speak HTTP tools rather than MCP: ChatGPT custom GPT
// Actions, Gemini / Grok function calling, n8n, Zapier, scripts. Every tool is POST /api/tools/{name} with the same JSON
// arguments as the MCP tool. ?for=gpt returns the 30 most useful tools (GPT Actions accept at most 30 operations).
import { TOOLS, VERSION } from '../../mcp/tools.js';

export const GPT_CORE = [
  'setup_status', 'list_channels', 'portfolio', 'channel_videos', 'daily_ideas', 'keyword_research', 'outliers', 'similar_channels',
  'radar_score', 'radar_watch', 'ctr_report', 'autopilot', 'best_publish_time', 'make_thumbnails', 'voiceover_short', 'render_video',
  'make_shorts', 'publish_status', 'publish_youtube', 'publish_instagram', 'publish_tiktok', 'publish_job', 'ig_outliers', 'ig_hashtag',
  'ig_lookup', 'tiktok_videos', 'get_settings', 'update_settings', 'add_channel', 'tubedesk_api',
];

const summary = d => { const s = String(d).split(/(?<=[.!?])\s/)[0]; return s.length > 120 ? s.slice(0, 117) + '…' : s; };

export function openapi({ base, profile = 'all' } = {}) {
  const tools = profile === 'gpt' ? GPT_CORE.map(n => TOOLS.find(t => t.name === n)).filter(Boolean) : TOOLS;
  const paths = {};
  for (const t of tools) {
    paths[`/api/tools/${t.name}`] = {
      post: {
        operationId: t.name, summary: summary(t.description), description: t.description.slice(0, 300),
        'x-openai-isConsequential': /^(publish_|update_settings|autopilot|make_shorts|add_channel|tubedesk_api)/.test(t.name),
        requestBody: { required: true, content: { 'application/json': { schema: t.inputSchema } } },
        responses: { 200: { description: 'Result', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, 400: { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } }, 401: { description: 'Missing or invalid key' } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'TubeDesk', version: VERSION, description: 'Your self-hosted YouTube/Instagram/TikTok growth desk: research, radar scoring, analytics, autopilot, Shorts, rendering and publishing. Every operation runs on the owner\'s Mac. File paths are absolute paths on that Mac.' },
    servers: [{ url: base }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'TubeDesk API key (Settings → Use TubeDesk from any AI → API keys) or an OAuth access token' } } },
    security: [{ bearer: [] }],
    paths,
  };
}
