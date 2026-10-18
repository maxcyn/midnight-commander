// Configures the ElevenLabs voice agent with the SecondShift prompt, dynamic variables,
// and backend Server Tools pointing to PUBLIC_URL.
// Run whenever PUBLIC_URL or TOOL_TOKEN changes:
//   npx tsx --env-file=.env scripts/configure-elevenlabs.ts

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

const apiKey = env("ELEVENLABS_API_KEY");
const agentId = env("ELEVENLABS_AGENT_ID");
const publicUrl = env("PUBLIC_URL").replace(/\/+$/, "");
const toolToken = env("TOOL_TOKEN");

const headers = { Authorization: `Bearer ${toolToken}` };
const incidentPathParam = {
  incident_id: {
    type: "string",
    dynamic_variable: "incident_id",
  },
};

const tools = [
  {
    type: "webhook",
    name: "explain_evidence",
    description:
      "Retrieve the incident briefing, observed impact, competing hypotheses, and supporting or conflicting Sentry and probe evidence when the engineer asks to explain the evidence or what is failing.",
    interruption_mode: "disable_during_tool_and_turn",
    api_schema: {
      url: `${publicUrl}/voice/incidents/{incident_id}/briefing`,
      method: "GET",
      request_headers: headers,
      path_params_schema: incidentPathParam,
    },
  },
  {
    type: "webhook",
    name: "check_dependency",
    description:
      "Run a live read-only dependency health probe against payments or recommendations when the engineer asks to check payments or check recommendations.",
    interruption_mode: "disable_during_tool_and_turn",
    api_schema: {
      url: `${publicUrl}/voice/incidents/{incident_id}/probe`,
      method: "POST",
      request_headers: headers,
      path_params_schema: incidentPathParam,
      request_body_schema: {
        type: "object",
        required: ["dependency"],
        properties: {
          dependency: {
            type: "string",
            description: "Which dependency to probe live: 'payments' or 'recommendations'",
            enum: ["payments", "recommendations"],
          },
        },
      },
    },
  },
  {
    type: "webhook",
    name: "approve_action",
    description:
      "Approve and execute the pending mitigation action (disable_recommendations) after the engineer explicitly confirms they want to disable recommendations for this incident.",
    interruption_mode: "disable_during_tool_and_turn",
    api_schema: {
      url: `${publicUrl}/voice/incidents/{incident_id}/approve`,
      method: "POST",
      request_headers: headers,
      path_params_schema: incidentPathParam,
      request_body_schema: {
        type: "object",
        required: ["action", "responder", "confirmed"],
        properties: {
          action: {
            type: "string",
            description: "The exact action being approved: 'disable_recommendations'",
            enum: ["disable_recommendations"],
          },
          responder: {
            type: "string",
            dynamic_variable: "responder",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true only when the engineer has explicitly approved disabling recommendations.",
          },
        },
      },
    },
  },
  {
    type: "webhook",
    name: "take_over",
    description:
      "Transfer incident ownership to the human engineer and halt all autonomous actions when the engineer says 'I will handle it' or 'I am taking over'.",
    interruption_mode: "disable_during_tool_and_turn",
    api_schema: {
      url: `${publicUrl}/voice/incidents/{incident_id}/take-over`,
      method: "POST",
      request_headers: headers,
      path_params_schema: incidentPathParam,
      request_body_schema: {
        type: "object",
        required: ["responder"],
        properties: {
          responder: {
            type: "string",
            dynamic_variable: "responder",
          },
        },
      },
    },
  },
  {
    type: "webhook",
    name: "check_status",
    description:
      "Check the current incident status, mitigation execution, and recovery verification status when the engineer asks 'Did it work?' or asks for status.",
    interruption_mode: "disable_during_tool_and_turn",
    api_schema: {
      url: `${publicUrl}/voice/incidents/{incident_id}/status`,
      method: "GET",
      request_headers: headers,
      path_params_schema: incidentPathParam,
    },
  },
];

const prompt = `You are SecondShift, an on-call incident-response voice assistant speaking on a phone call with engineer {{responder}} about incident #{{incident_id}}.
Pending proposed action: {{proposed_action}}.

BEHAVIOR & TONE
- Keep every spoken response brief (1 to 3 short sentences), clear, and calm for a phone call.
- Never invent probabilities or confidence percentages (never say "97% confident"). Use only evidence-based terms: supported, inconclusive, or contradicted.
- Speak strictly from the incident record returned by your tools.

HOW TO HANDLE SPOKEN REQUESTS
1. "Explain the evidence" / "What is happening?" -> Call explain_evidence and summarize the impact, which hypothesis is supported vs contradicted, and the key Sentry/probe evidence.
2. "Check payments" / "Check recommendations" -> Call check_dependency with dependency="payments" (or "recommendations") and report the live health and latency.
3. "Disable recommendations" / "Approve this action" / "Go ahead" -> Call approve_action with action="disable_recommendations" and confirmed=true, then report the result.
4. "I'll handle it" / "I'm taking over" -> Call take_over to transfer control to {{responder}} and stop autonomous actions.
5. "Did it work?" / "What's the status?" -> Call check_status and report the current incident and verification status.`;

const payload = {
  conversation_config: {
    turn: {
      turn_eagerness: "patient",
    },
    vad: {
      background_voice_detection: true,
    },
    agent: {
      first_message: "{{call_briefing}}",
      dynamic_variables: {
        dynamic_variable_placeholders: {
          incident_id: "1",
          call_id: "1",
          responder: "primary-engineer",
          proposed_action: "disable_recommendations",
          call_briefing:
            "SecondShift here about incident 1. Checkout requests are failing. Recommendation timeouts are the leading cause. I propose disabling recommendations; purchases could continue without product suggestions. Would you like the evidence, approve this action, or take over?",
        },
      },
      prompt: {
        prompt,
        tools,
      },
    },
  },
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: {
          first_message: true,
        },
      },
    },
  },
};

const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
  method: "PATCH",
  headers: {
    "xi-api-key": apiKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const out: any = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Failed to update ElevenLabs agent (${res.status}):`, JSON.stringify(out, null, 2));
  process.exit(1);
}

console.log(`Configured ElevenLabs agent '${out.name}' (${out.agent_id})`);
console.log(`  first_message: ${out.conversation_config?.agent?.first_message}`);
console.log(`  tools (${out.conversation_config?.agent?.prompt?.tools?.length ?? 0}):`, (out.conversation_config?.agent?.prompt?.tools ?? []).map((t: any) => t.name).join(", "));
console.log(`  public_url:    ${publicUrl}`);
