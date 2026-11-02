// Approved exception (owner decision 50b): these 2026-10-30 fixtures came from paid calls; no further paid calls are made.
// Recorded OpenRouter /chat/completions responses (2026-10-30, STORY-028 / owner decision 42). REAL responses, ids replaced and
// reasoning text/signatures removed; nothing account-identifying and no credential appears (the key travels in the Authorization header).
//
//   freeGemma                 google/gemma-4-26b-a4b-it:free, plain call (the dev-only plumbing path). Free: cost 0.
//   gptSearchInlineUrl        openai/gpt-5.4 + the web plugin (engine native). NO annotations: OpenRouter does not standardise OpenAI's native
//                             search into url_citation here; the source is an inline URL in the text (utm_source=openai). Stopped at max_tokens.
//   sonarAnnotations          perplexity/sonar, NO plugin (sonar is search-native; the plugin answers 404). 18 url_citation annotations,
//                             start_index = end_index = 0, so the ARRAY ORDER is the only order there is.
//   claudeReasoningTruncated  anthropic/claude-sonnet-5.5 + the web plugin at max_tokens 400: the budget went on reasoning, content is
//                             null, finish_reason length. A real "truncated and empty" answer. Annotations for Claude were NOT observed.
//
// Re-record, never hand-edit, with scripts/record-openrouter-fixtures.mjs.
export const freeGemma = {
  "id": "gen-recorded-free-0001",
  "object": "chat.completion",
  "model": "google/gemma-4-26b-a4b-it:free",
  "provider": "Google AI Studio",
  "system_fingerprint": null,
  "service_tier": "default",
  "choices": [
    {
      "index": 0,
      "logprobs": null,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "A Customer Relationship Management (CRM) system is a technology used to manage all of a company's relationships and interactions with customers and potential leads. Its primary goal is to improve business relationships by streamlining processes, centralizing data, and driving sales growth.",
        "refusal": null,
        "reasoning": null
      }
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 50,
    "total_tokens": 60,
    "cost": 0,
    "is_byok": false,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "cost_details": {
      "upstream_inference_cost": 0,
      "upstream_inference_prompt_cost": 0,
      "upstream_inference_completions_cost": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "image_tokens": 0,
      "audio_tokens": 0
    }
  }
} as const;

export const gptSearchInlineUrl = {
  "id": "gen-recorded-gpt-0001",
  "object": "chat.completion",
  "model": "openai/gpt-5.4",
  "provider": "OpenAI",
  "system_fingerprint": null,
  "service_tier": "default",
  "choices": [
    {
      "index": 0,
      "logprobs": null,
      "finish_reason": "length",
      "message": {
        "role": "assistant",
        "content": "For a **50-person startup**, the “best” CRM usually means a tool that balances **fast adoption, enough automation, reasonable per-seat cost, and room to grow**. For most teams, I’d shortlist these:\n\n## Best CRM tools for a 50-person startup\n\n### 1. **HubSpot Sales Hub / Smart CRM**\n**Best for:** all-in-one growth across sales, marketing, and customer success.  \nHubSpot is a strong fit if your startup wants one system shared across GTM teams, not just a sales pipeline. HubSpot’s CRM is free to start, and its paid Sales Hub tiers add automation and more advanced sales features. Official pricing pages show free tools plus paid Sales Hub tiers, while HubSpot’s materials emphasize the shared CRM across marketing, sales, service, and ops. ([hubspot.com](https://www.hubspot.com/Products/crm?utm_source=openai)",
        "refusal": null,
        "reasoning": null
      }
    }
  ],
  "usage": {
    "prompt_tokens": 17045,
    "completion_tokens": 500,
    "total_tokens": 17545,
    "cost": 0.0717605,
    "is_byok": false,
    "prompt_tokens_details": {
      "cached_tokens": 3712,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "cost_details": {
      "upstream_inference_cost": 0.0717605,
      "upstream_inference_prompt_cost": 0.0342605,
      "upstream_inference_completions_cost": 0.0075
    },
    "completion_tokens_details": {
      "reasoning_tokens": 315,
      "image_tokens": 0,
      "audio_tokens": 0
    },
    "server_tool_use_details": {
      "web_search_requests": 3
    }
  }
} as const;

export const sonarAnnotations = {
  "id": "gen-recorded-sonar-0001",
  "object": "chat.completion",
  "model": "perplexity/sonar",
  "provider": "Perplexity",
  "system_fingerprint": null,
  "service_tier": null,
  "choices": [
    {
      "index": 0,
      "logprobs": null,
      "finish_reason": "length",
      "message": {
        "role": "assistant",
        "content": "For a **50-person startup**, the strongest CRM picks are usually **HubSpot CRM**, **Pipedrive**, **Zoho CRM**, **Salesforce Starter Suite**, and **monday CRM**. These tools repeatedly show up in startup-focused rankings for teams in the **20–50 employee** or **small business / growth** range, with HubSpot best for marketing-led teams, Pipedrive for pipeline-first sales teams, Zoho for budget-conscious teams, Salesforce for long-term scalability, and monday CRM for collaboration-heavy workflows.[1][2][8][12][16]\n\n| CRM tool | Best fit for a 50-person startup | Why it stands out |\n|---|---|---|\n| **HubSpot CRM** | Marketing-led startups | Strong free foundation, broad sales/marketing/service suite, and clear path to scale.[2][8][14][16] |\n| **Pipedrive** | Sales-driven teams | Simple visual pipeline management and strong fit for teams focused on closing deals.[1][3][8][11][12][16] |\n| **Zoho CRM** | Budget-conscious teams | Low entry price, lots of customization, and good automation depth for the cost.[2][5][8][12][14][16] |\n| **Salesforce Starter Suite** | Startups planning to scale fast | Best long-term scalability and enterprise-grade flexibility, though usually more complex.[2][5][8][12][16] |\n| **monday CRM** | Cross-functional teams | Useful when sales needs to stay connected with project delivery and internal collaboration.[2][12][16] |\n\nIf you want the **best default choice**, **HubSpot CRM** is the safest recommendation for most 50-person startups because it combines a free entry point, strong startup adoption, and enough functionality to grow with the company.[2][8][14]\n\nIf your startup is more specialized:\n- Choose **Pipedrive** if your main need is a clean **sales pipeline** and fast rep adoption.[1][3][11][16]\n- Choose **Zoho CRM** if you want **lower cost** and deeper customization.[2][5][8][12][14][16]\n- Choose **Sales",
        "refusal": null,
        "reasoning": null,
        "annotations": [
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.folk.app/articles/best-crms-software-for-startups",
              "title": "18 Best CRMs Software for Startups in 2026 - folk.app",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://slack.com/intl/es-ar/blog/crm/best-crms-for-startups",
              "title": "Best CRMs for Startups: Tools, Benefits, and Tips",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.folk.app/articles/best-crm-saas-startups",
              "title": "5 Best CRM for SaaS startups in 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.folk.app/articles/best-free-crm-startups",
              "title": "Best Free CRM for Startups in 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.salesforce.com/crm/free-crm/best-free-crms/?bc=OTH",
              "title": "Best Free CRMs For Startups and SMBs in 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://tekpon.com/insights/sales-cs/crm/crm-software-for-growth/",
              "title": "Related Insights Articles",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.pcmag.com/picks/the-best-small-business-crm-software",
              "title": "The Best Small Business CRM Software We've Tested for 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.techradar.com/best/the-best-crm-for-startups",
              "title": "Best CRM for startups of 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://resources.rework.com/tools/crm/best-crm-software-2026",
              "title": "\"Best CRM Software in 2026: 15 Tools Ranked by Fit\"",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://attio.com/f/best-crm-for-small-business",
              "title": "Best CRMs for small business in 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.zite.com/blog/best-crm-software-for-small-business",
              "title": "7 Best CRM Software for Small Businesses in 2026 (I Tested 12) - Zite",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.techrepublic.com/article/best-crm-startups/",
              "title": "Best CRM Software for Startups",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://optif.ai/media/articles/best-crm-small-teams/",
              "title": "15 Best CRM Tools for Small Teams (Free + Paid) - Optifai",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.quickbase.com/blog/best-crm-for-startups-small-business",
              "title": "The Best CRM for Startups and Small Businesses",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.techradar.com/best/the-best-crm-software",
              "title": "The 13 best CRM platforms in 2026",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://monday.com/blog/crm-and-sales/crm-for-start-ups/",
              "title": "2. Hubspot Crm",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://close.com/blog/crms-for-startups",
              "title": "10 Best CRMs for Startups in 2026: Ultimate Guide, Reviews ...",
              "start_index": 0,
              "end_index": 0
            }
          },
          {
            "type": "url_citation",
            "url_citation": {
              "url": "https://www.uschamber.com/co/start/strategy/low-cost-crm-tools",
              "title": "CRM for Small Business: Top Free or Low-Cost Options",
              "start_index": 0,
              "end_index": 0
            }
          }
        ]
      }
    }
  ],
  "usage": {
    "prompt_tokens": 17,
    "completion_tokens": 500,
    "total_tokens": 517,
    "cost": 0.00552,
    "is_byok": false,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "cost_details": {
      "upstream_inference_cost": 0.00552,
      "upstream_inference_prompt_cost": 0.000017,
      "upstream_inference_completions_cost": 0.005503
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "image_tokens": 0,
      "audio_tokens": 0
    }
  }
} as const;

export const claudeReasoningTruncated = {
  "id": "gen-recorded-claude-0001",
  "object": "chat.completion",
  "model": "anthropic/claude-sonnet-5.5",
  "provider": "Claude Platform on AWS",
  "system_fingerprint": null,
  "service_tier": "default",
  "choices": [
    {
      "index": 0,
      "logprobs": null,
      "finish_reason": "length",
      "message": {
        "role": "assistant",
        "content": null,
        "refusal": null,
        "reasoning": null,
        "reasoning_details": []
      }
    }
  ],
  "usage": {
    "prompt_tokens": 44184,
    "completion_tokens": 520,
    "total_tokens": 44704,
    "cost": 0.113568,
    "is_byok": false,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "cost_details": {
      "upstream_inference_cost": 0.113568,
      "upstream_inference_prompt_cost": 0.088368,
      "upstream_inference_completions_cost": 0.0052
    },
    "completion_tokens_details": {
      "reasoning_tokens": 400,
      "image_tokens": 0,
      "audio_tokens": 0
    },
    "server_tool_use_details": {
      "web_search_requests": 2
    }
  }
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// HAND-AUTHORED to OpenRouter's documented schemas (openrouter.ai/docs: chat completions, web search annotations, errors). A live call
// cannot be made to refuse, hit a rate limit or run out of credit on demand. Replace with recordings when the owner tops up and
// scripts/record-openrouter-fixtures.mjs has been run; until then these are labelled documentation-shaped, not observed.

/** Documented url_citation annotations on an Anthropic answer, with one URL cited twice (OpenRouter emits one annotation per span). */
export const claudeAnnotatedDocumented = {
  id: "gen-documented-claude-0001",
  object: "chat.completion",
  model: "anthropic/claude-sonnet-5.5",
  provider: "Anthropic",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "HubSpot and Pipedrive are common picks for a 50-person startup. Pipedrive is pipeline-first.",
        refusal: null,
        annotations: [
          { type: "url_citation", url_citation: { url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", start_index: 0, end_index: 7 } },
          { type: "url_citation", url_citation: { url: "https://www.pipedrive.com/en", title: "Pipedrive", content: "Sales CRM", start_index: 12, end_index: 21 } },
          { type: "url_citation", url_citation: { url: "https://www.pipedrive.com/en", title: "Pipedrive", start_index: 60, end_index: 69 } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, cost: 0.0042 },
} as const;

export const noModelField = {
  id: "gen-documented-nomodel-0001",
  object: "chat.completion",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "An answer with no model field." } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
} as const;

export const refusalContentFilter = {
  id: "gen-documented-refusal-0001",
  object: "chat.completion",
  model: "openai/gpt-5.4",
  choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: "", refusal: "I can't help with that." } }],
  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18, cost: 0.0002 },
} as const;

/** No `choices` at all: not a chat completion. It still carries a readable cost, which the vendor billed. */
export const malformedPayload = { id: "gen-documented-malformed-0001", object: "chat.completion", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0003 } } as const;

export const insufficientCredits402 = { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } } as const;
export const rateLimited429 = { error: { code: 429, message: "Rate limit exceeded", metadata: { headers: { "X-RateLimit-Limit": "20" } } } } as const;
export const upstreamError502 = { error: { code: 502, message: "Provider returned error", metadata: { provider_name: "OpenAI" } } } as const;
export const invalidKey401 = { error: { code: 401, message: "No auth credentials found" } } as const;
export const noNativeSearch404 = { error: { code: 404, message: "The requested model does not support native web search. Use engine: \"auto\" or \"exa\" instead." } } as const;

/** DOCUMENTED shape (OpenRouter errors page, 403), not a recorded call: the chosen model requires moderation and the input was flagged. */
export const moderation403 = { error: { code: 403, message: "Your chosen model requires moderation and your input was flagged", metadata: { reasons: ["harassment"], flagged_input: "(redacted)", provider_name: "OpenAI", model_slug: "openai/gpt-5.4" } } } as const;
/** A 403 with no moderation metadata: blocked as well (decision 50c), and not a credential fault. */
export const forbidden403 = { error: { code: 403, message: "Forbidden" } } as const;
