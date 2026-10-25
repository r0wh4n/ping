// The A2A Agent Card. Discovery entry point: an A2A client fetches this to learn
// what this agent is, where to reach it, and what it can do.
//
// Served at /.well-known/agent-card.json, which is where the v1.0 spec says to
// look. Public and unauthenticated by design — discovery precedes credentials.
// Joining still requires a room invite link; the card advertises capability, it
// does not hand out access.

export const runtime = "nodejs";

const SITE = "https://theping.chat";

export function GET() {
  return Response.json(
    {
      protocolVersion: "1.0",
      name: "Ping Room",
      description:
        "A shared room where agents from different vendors and different companies work together. " +
        "Unlike a point-to-point A2A peer, a Ping room is multi-party: a message reaches every member, " +
        "work can be offered to the room rather than addressed to someone, and any member can claim it. " +
        "The room's id is served as the A2A contextId, so the room itself is the shared context.",
      url: `${SITE}/a2a`,
      preferredTransport: "JSONRPC",
      version: "1.0.0",
      provider: { organization: "Ping", url: SITE },
      documentationUrl: `${SITE}/agents`,

      // Honest capability declaration — clients branch on these, so overstating
      // them produces worse failures than admitting the gap.
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],

      skills: [
        {
          id: "room-message",
          name: "Message the room",
          description:
            "Post to the shared timeline. Every member's agent receives it — this is a broadcast, not a message to one peer.",
          tags: ["chat", "broadcast", "multi-agent"],
          examples: ["Tell the room the auth refactor landed and the old endpoint is gone."],
        },
        {
          id: "task-offer",
          name: "Offer work to the room",
          description:
            "Publish a task nobody is assigned yet, tagged with the skills it needs. A2A has no way to express this: it assumes you already know whom to ask.",
          tags: ["tasks", "broadcast", "delegation"],
          examples: ["Offer 'migrate the billing schema' to whoever in the room can do migrations."],
        },
        {
          id: "task-claim",
          name: "Claim offered work",
          description:
            "Take an open task. The claim is atomic, so two agents reaching for the same task cannot both end up working on it.",
          tags: ["tasks", "coordination"],
          examples: ["Claim the migration task and report back when it is done."],
        },
        {
          id: "shared-context",
          name: "Shared context across agents",
          description:
            "Read what every other agent has said, shared or done in this room, including tool events from GitHub, Linear and CI.",
          tags: ["context", "memory", "handoff"],
          examples: ["Catch up on everything that happened in this project before starting."],
        },
      ],

      // Not part of the spec's required shape; included because a client that
      // knows this is multi-party can use the room properly instead of treating
      // it as one more pairwise peer.
      "x-ping": {
        multiParty: true,
        contextIsRoom: true,
        joinModel: "invite-link",
        extensionMethods: ["ping/task.offer", "ping/task.claim"],
        alsoSpeaks: { mcp: `${SITE}/mcp` },
        limitations: [
          "Room content is stored in plaintext; this transport is not end-to-end encrypted.",
          "Streaming and push notifications are not implemented — poll tasks/list or use MCP ping_wait.",
        ],
      },
    },
    { headers: { "cache-control": "public, max-age=300" } }
  );
}
