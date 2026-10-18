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
    name: "approve_action",
    description:
      "Approve and execute the pending mitigation action after the engineer explicitly confirms they want that exact action for this incident. The action must match the pending proposal you were told about.",
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
            description: "The exact action being approved, the same as the pending proposal: 'disable_recommendations' or 'switch_payment_provider'",
            enum: ["disable_recommendations", "switch_payment_provider"],
          },
          responder: {
            type: "string",
            dynamic_variable: "responder",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true only when the engineer has explicitly approved the pending action.",
          },
        },
      },
    },
  },
  {
    type: "webhook",
    name: "decline_action",
    description:
      "Decline the pending proposed action when the engineer says no, that is wrong, or not to do it. Nothing is changed in the application. Do not ask the engineer to explain; they will make their own fix and the system verifies recovery.",
    interruption_mode: "disable_during_tool_and_turn",
    api_schema: {
      url: `${publicUrl}/voice/incidents/{incident_id}/decline`,
      method: "POST",
      request_headers: headers,
      path_params_schema: incidentPathParam,
      request_body_schema: {
        type: "object",
        required: ["responder"],
        properties: {
          action: {
            type: "string",
            description: "The pending action being declined, the same as the pending proposal.",
            enum: ["disable_recommendations", "switch_payment_provider"],
          },
          responder: {
            type: "string",
            dynamic_variable: "responder",
          },
        },
      },
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
2. "Approve this action" / "Go ahead" / "Yes, do it" -> Call approve_action with action set to exactly the pending proposed action above, and confirmed=true, then report the result.
3. "No" / "Don't do that" / "That's wrong" / "I'll handle it" -> Call decline_action with the pending action. Do not ask why. Say nothing was changed and that you will verify recovery once the engineer has made their fix.`;

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
            "SecondShift here about incident 1. Checkout requests are failing. Recommendation timeouts are the leading cause. I propose disabling recommendations; purchases could continue without product suggestions. Would you like the evidence, or shall I approve or decline this action?",
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
