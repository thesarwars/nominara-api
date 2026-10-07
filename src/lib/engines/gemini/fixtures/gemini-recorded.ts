// NEW-A-3 — recorded Gemini generateContent responses (gemini-2.5-flash, google_search grounding).
//
// Provenance: `normalGrounded` and `invalidKeyError` are REAL responses recorded 2026-10-07 from
// generativelanguage.googleapis.com/v1beta. No credential appears in either: the key travels in the
// x-goog-api-key request header, never the body, and the response does not echo it. The
// refusal, empty, truncated and malformed payloads are hand-authored to the same recorded shape
// (opaque redirect tokens are shortened to placeholders; shape, host and path prefix are as recorded) (a live call cannot be made to refuse or truncate on demand). Re-record, never hand-edit, the first two.
export const normalGrounded = {
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "For a 50-person startup, the \"best\" CRM tools are typically those that offer scalability, essential features for a growing team, ease of use, integration capabilities, and flexible pricing. These tools should centralize customer data, streamline sales and marketing efforts, and provide insights to support continued growth.\n\nHere are some of the best CRM tools for a 50-person startup:\n\n*   **HubSpot CRM**: Often praised for its user-friendliness and generous free tier, HubSpot is ideal for marketing-led startups seeking a unified platform for sales and marketing workflows. It provides a solid foundation for contact management, deal tracking, email marketing, and basic reporting, with a clear upgrade path as the company scales. While its free and starter tiers have basic automation and reporting, it's a strong fit for teams prioritizing ease of use and future expansion into a broader revenue platform.\n*   **Zoho CRM**: This platform is a strong contender for startups and small to medium-sized businesses looking for a feature-rich CRM at an affordable price. Zoho CRM covers core functionalities like lead, contact, account, and deal management, along with tasks, events, and reports. It also offers advanced features such as AI-assisted insights, custom modules, and process automation, which can support more complex sales operations without requiring a switch to a different platform. However, its extensive features might require more setup time for smaller teams.\n*   **Pipedrive**: Best suited for sales-led startups, Pipedrive excels in pipeline management with a highly visual and intuitive interface. It helps sales teams efficiently track deals, manage activities, and move opportunities forward. Its focus on usability and activity-based sales management allows for quick adoption and helps teams concentrate on selling. Pipedrive is particularly beneficial for those who prioritize a straightforward, deal-focused CRM without extensive marketing or service capabilities.\n*   **Salesforce Starter Suite**: As a robust CRM platform, Salesforce offers a Starter Suite designed to be more accessible for startups with aggressive growth plans. It provides powerful automation, AI tools, and extensive integration options, making it suitable for teams that anticipate rapid scaling and may eventually require enterprise-grade features. While it may have a steeper learning curve, the benefits of advanced customization and its comprehensive ecosystem can be significant for technically inclined teams.\n*   **Conduyt**: This CRM aims to be a solution that startups can adopt once and grow with, avoiding the need for future migrations due to scaling costs or feature limitations. It offers a flat monthly rate regardless of the number of users, which can be highly advantageous for a 50-person startup with plans for further expansion. Conduyt emphasizes quick operational setup, real automation out-of-the-box (including lead routing and follow-up sequences), and native AI features.\n\n**Key CRM Features for a 50-Person Startup:**\n\nWhen selecting a CRM, a 50-person startup should prioritize the following features:\n\n*   **Contact and Activity Management**: A centralized database to store and organize all lead, customer, and conversation data, with automatic updates for emails, calls, and meetings.\n*   **Lead and Deal Management**: Tools to help identify leads, track their progress through the sales pipeline, and manage sales opportunities.\n*   **Automation and Workflows**: Capabilities to automate repetitive tasks such as data entry, follow-up reminders, and email sequences, allowing the team to focus on higher-value activities.\n*   **Reporting and Analytics**: Features that provide insights into sales performance, customer behavior, and marketing campaign effectiveness through customizable dashboards and reports.\n*   **Scalability**: The ability of the CRM to grow with the company, accommodating more users, data, and advanced functionalities without compromising performance or requiring a complete system overhaul.\n*   **Integration Capabilities**: Seamless integration with other essential business tools like email platforms, accounting software, and marketing apps.\n*   **Mobile Access**: Functionality that allows team members to access and update CRM information from anywhere, supporting remote or on-the-go work.\n\n**Pricing Considerations:**\n\nFor a startup, CRM costs can range significantly. Many small businesses, including those with around 50 employees, typically spend between $10 and $50 per user per month. However, prices can go up for more advanced features, automation, and AI tools. Some CRMs offer free tiers (like HubSpot and Zoho CRM) which can be a good starting point to establish the habit of tracking relationships before upgrading to paid plans. It's important to consider not just the per-user monthly fee but also potential setup fees, add-ons for advanced features, and the overall value the CRM provides in terms of increased sales and efficiency."
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0,
      "groundingMetadata": {
        "searchEntryPoint": {
          "renderedContent": "<style>\n.container {\n  align-items: center;\n  border-radius: 8px;\n  display: flex;\n  font-family: Google Sans, Roboto, sans-serif;\n  font-size: 14px;\n  line-height: 20px;\n  padding: 8px 12px;\n}\n.chip {\n  display: inline-block;\n  border: solid 1px;\n  border-radius: 16px;\n  min-width: 14px;\n  padding: 5px 16px;\n  text-align: center;\n  user-select: none;\n  margin: 0 8px;\n  -webkit-tap-highlight-color: transparent;\n}\n.carousel {\n  overflow: auto;\n  scrollbar-width: none;\n  white-space: nowrap;\n  margin-right: -12px;\n}\n.headline {\n  display: flex;\n  margin-right: 4px;\n}\n.gradient-container {\n  position: relative;\n}\n.gradient {\n  position: absolute;\n  transform: translate(3px, -9px);\n  height: 36px;\n  width: 9px;\n}\n@media (prefers-color-scheme: light) {\n  .container {\n    background-color: #fafafa;\n    box-shadow: 0 0 0 1px #0000000f;\n  }\n  .headline-label {\n    color: #1f1f1f;\n  }\n  .chip {\n    background-color: #ffffff;\n    border-color: #d2d2d2;\n    color: #5e5e5e;\n    text-decoration: none;\n  }\n  .chip:hover {\n    background-color: #f2f2f2;\n  }\n  .chip:focus {\n    background-color: #f2f2f2;\n  }\n  .chip:active {\n    background-color: #d8d8d8;\n    border-color: #b6b6b6;\n  }\n  .logo-dark {\n    display: none;\n  }\n  .gradient {\n    background: linear-gradient(90deg, #fafafa 15%, #fafafa00 100%);\n  }\n}\n@media (prefers-color-scheme: dark) {\n  .container {\n    background-color: #1f1f1f;\n    box-shadow: 0 0 0 1px #ffffff26;\n  }\n  .headline-label {\n    color: #fff;\n  }\n  .chip {\n    background-color: #2c2c2c;\n    border-color: #3c4043;\n    color: #fff;\n    text-decoration: none;\n  }\n  .chip:hover {\n    background-color: #353536;\n  }\n  .chip:focus {\n    background-color: #353536;\n  }\n  .chip:active {\n    background-color: #464849;\n    border-color: #53575b;\n  }\n  .logo-light {\n    display: none;\n  }\n  .gradient {\n    background: linear-gradient(90deg, #1f1f1f 15%, #1f1f1f00 100%);\n  }\n}\n</style>\n<div class=\"container\">\n  <div class=\"headline\">\n    <svg class=\"logo-light\" width=\"18\" height=\"18\" viewBox=\"9 9 35 35\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M42.8622 27.0064C42.8622 25.7839 42.7525 24.6084 42.5487 23.4799H26.3109V30.1568H35.5897C35.1821 32.3041 33.9596 34.1222 32.1258 35.3448V39.6864H37.7213C40.9814 36.677 42.8622 32.2571 42.8622 27.0064V27.0064Z\" fill=\"#4285F4\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 43.8555C30.9659 43.8555 34.8687 42.3195 37.7213 39.6863L32.1258 35.3447C30.5898 36.3792 28.6306 37.0061 26.3109 37.0061C21.8282 37.0061 18.0195 33.9811 16.6559 29.906H10.9194V34.3573C13.7563 39.9841 19.5712 43.8555 26.3109 43.8555V43.8555Z\" fill=\"#34A853\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M16.6559 29.8904C16.3111 28.8559 16.1074 27.7588 16.1074 26.6146C16.1074 25.4704 16.3111 24.3733 16.6559 23.3388V18.8875H10.9194C9.74388 21.2072 9.06992 23.8247 9.06992 26.6146C9.06992 29.4045 9.74388 32.022 10.9194 34.3417L15.3864 30.8621L16.6559 29.8904V29.8904Z\" fill=\"#FBBC05\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 16.2386C28.85 16.2386 31.107 17.1164 32.9095 18.8091L37.8466 13.8719C34.853 11.082 30.9659 9.3736 26.3109 9.3736C19.5712 9.3736 13.7563 13.245 10.9194 18.8875L16.6559 23.3388C18.0195 19.2636 21.8282 16.2386 26.3109 16.2386V16.2386Z\" fill=\"#EA4335\"/>\n    </svg>\n    <svg class=\"logo-dark\" width=\"18\" height=\"18\" viewBox=\"0 0 48 48\" xmlns=\"http://www.w3.org/2000/svg\">\n      <circle cx=\"24\" cy=\"23\" fill=\"#FFF\" r=\"22\"/>\n      <path d=\"M33.76 34.26c2.75-2.56 4.49-6.37 4.49-11.26 0-.89-.08-1.84-.29-3H24.01v5.99h8.03c-.4 2.02-1.5 3.56-3.07 4.56v.75l3.91 2.97h.88z\" fill=\"#4285F4\"/>\n      <path d=\"M15.58 25.77A8.845 8.845 0 0 0 24 31.86c1.92 0 3.62-.46 4.97-1.31l4.79 3.71C31.14 36.7 27.65 38 24 38c-5.93 0-11.01-3.4-13.45-8.36l.17-1.01 4.06-2.85h.8z\" fill=\"#34A853\"/>\n      <path d=\"M15.59 20.21a8.864 8.864 0 0 0 0 5.58l-5.03 3.86c-.98-2-1.53-4.25-1.53-6.64 0-2.39.55-4.64 1.53-6.64l1-.22 3.81 2.98.22 1.08z\" fill=\"#FBBC05\"/>\n      <path d=\"M24 14.14c2.11 0 4.02.75 5.52 1.98l4.36-4.36C31.22 9.43 27.81 8 24 8c-5.93 0-11.01 3.4-13.45 8.36l5.03 3.85A8.86 8.86 0 0 1 24 14.14z\" fill=\"#EA4335\"/>\n    </svg>\n    <div class=\"gradient-container\"><div class=\"gradient\"></div></div>\n  </div>\n  <div class=\"carousel\">\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aa\">CRM for growing startups</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ab\">best CRM tools for 50 person startup</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ac\">scalable CRM solutions for small businesses</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ad\">CRM pricing for startups</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ae\">CRM features for sales and marketing teams</a>\n  </div>\n</div>\n"
        },
        "groundingChunks": [
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-af",
              "title": "markestac.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ag",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ah",
              "title": "monday.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ai",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aj",
              "title": "quickbase.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ak",
              "title": "baserow.io"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-al",
              "title": "attio.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-am",
              "title": "bigcontacts.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-an",
              "title": "conduyt.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ao",
              "title": "uschamber.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ap",
              "title": "salesflare.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aq",
              "title": "fayedigital.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ar",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-as",
              "title": "nimble.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-at",
              "title": "zeeg.me"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-au",
              "title": "creatio.com"
            }
          }
        ],
        "groundingSupports": [
          {
            "segment": {
              "startIndex": 190,
              "endIndex": 323,
              "text": "These tools should centralize customer data, streamline sales and marketing efforts, and provide insights to support continued growth"
            },
            "groundingChunkIndices": [
              0,
              1,
              2,
              3
            ]
          },
          {
            "segment": {
              "startIndex": 388,
              "endIndex": 577,
              "text": "*   **HubSpot CRM**: Often praised for its user-friendliness and generous free tier, HubSpot is ideal for marketing-led startups seeking a unified platform for sales and marketing workflows"
            },
            "groundingChunkIndices": [
              4,
              5,
              2,
              6
            ]
          },
          {
            "segment": {
              "startIndex": 579,
              "endIndex": 734,
              "text": "It provides a solid foundation for contact management, deal tracking, email marketing, and basic reporting, with a clear upgrade path as the company scales"
            },
            "groundingChunkIndices": [
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 736,
              "endIndex": 911,
              "text": "While its free and starter tiers have basic automation and reporting, it's a strong fit for teams prioritizing ease of use and future expansion into a broader revenue platform"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 913,
              "endIndex": 1070,
              "text": "*   **Zoho CRM**: This platform is a strong contender for startups and small to medium-sized businesses looking for a feature-rich CRM at an affordable price"
            },
            "groundingChunkIndices": [
              4,
              5,
              2
            ]
          },
          {
            "segment": {
              "startIndex": 1198,
              "endIndex": 1399,
              "text": "It also offers advanced features such as AI-assisted insights, custom modules, and process automation, which can support more complex sales operations without requiring a switch to a different platform"
            },
            "groundingChunkIndices": [
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 1401,
              "endIndex": 1480,
              "text": "However, its extensive features might require more setup time for smaller teams"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1482,
              "endIndex": 1621,
              "text": "*   **Pipedrive**: Best suited for sales-led startups, Pipedrive excels in pipeline management with a highly visual and intuitive interface"
            },
            "groundingChunkIndices": [
              4,
              2,
              6,
              7
            ]
          },
          {
            "segment": {
              "startIndex": 1720,
              "endIndex": 1843,
              "text": "Its focus on usability and activity-based sales management allows for quick adoption and helps teams concentrate on selling"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1845,
              "endIndex": 1994,
              "text": "Pipedrive is particularly beneficial for those who prioritize a straightforward, deal-focused CRM without extensive marketing or service capabilities"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1996,
              "endIndex": 2162,
              "text": "*   **Salesforce Starter Suite**: As a robust CRM platform, Salesforce offers a Starter Suite designed to be more accessible for startups with aggressive growth plans"
            },
            "groundingChunkIndices": [
              5
            ]
          },
          {
            "segment": {
              "startIndex": 2164,
              "endIndex": 2353,
              "text": "It provides powerful automation, AI tools, and extensive integration options, making it suitable for teams that anticipate rapid scaling and may eventually require enterprise-grade features"
            },
            "groundingChunkIndices": [
              5,
              2,
              6,
              7
            ]
          },
          {
            "segment": {
              "startIndex": 2355,
              "endIndex": 2519,
              "text": "While it may have a steeper learning curve, the benefits of advanced customization and its comprehensive ecosystem can be significant for technically inclined teams"
            },
            "groundingChunkIndices": [
              5,
              6
            ]
          },
          {
            "segment": {
              "startIndex": 2521,
              "endIndex": 2696,
              "text": "*   **Conduyt**: This CRM aims to be a solution that startups can adopt once and grow with, avoiding the need for future migrations due to scaling costs or feature limitations"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 2698,
              "endIndex": 2852,
              "text": "It offers a flat monthly rate regardless of the number of users, which can be highly advantageous for a 50-person startup with plans for further expansion"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 2854,
              "endIndex": 3001,
              "text": "Conduyt emphasizes quick operational setup, real automation out-of-the-box (including lead routing and follow-up sequences), and native AI features"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 3136,
              "endIndex": 3319,
              "text": "*   **Contact and Activity Management**: A centralized database to store and organize all lead, customer, and conversation data, with automatic updates for emails, calls, and meetings"
            },
            "groundingChunkIndices": [
              1,
              9,
              10,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 3321,
              "endIndex": 3464,
              "text": "*   **Lead and Deal Management**: Tools to help identify leads, track their progress through the sales pipeline, and manage sales opportunities"
            },
            "groundingChunkIndices": [
              1,
              9,
              10
            ]
          },
          {
            "segment": {
              "startIndex": 3466,
              "endIndex": 3657,
              "text": "*   **Automation and Workflows**: Capabilities to automate repetitive tasks such as data entry, follow-up reminders, and email sequences, allowing the team to focus on higher-value activities"
            },
            "groundingChunkIndices": [
              1,
              10,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 3659,
              "endIndex": 3846,
              "text": "*   **Reporting and Analytics**: Features that provide insights into sales performance, customer behavior, and marketing campaign effectiveness through customizable dashboards and reports"
            },
            "groundingChunkIndices": [
              1,
              9,
              10,
              12
            ]
          },
          {
            "segment": {
              "startIndex": 3848,
              "endIndex": 4051,
              "text": "*   **Scalability**: The ability of the CRM to grow with the company, accommodating more users, data, and advanced functionalities without compromising performance or requiring a complete system overhaul"
            },
            "groundingChunkIndices": [
              1,
              3
            ]
          },
          {
            "segment": {
              "startIndex": 4053,
              "endIndex": 4205,
              "text": "*   **Integration Capabilities**: Seamless integration with other essential business tools like email platforms, accounting software, and marketing apps"
            },
            "groundingChunkIndices": [
              13,
              10
            ]
          },
          {
            "segment": {
              "startIndex": 4207,
              "endIndex": 4356,
              "text": "*   **Mobile Access**: Functionality that allows team members to access and update CRM information from anywhere, supporting remote or on-the-go work"
            },
            "groundingChunkIndices": [
              10,
              12,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 4438,
              "endIndex": 4557,
              "text": "Many small businesses, including those with around 50 employees, typically spend between $10 and $50 per user per month"
            },
            "groundingChunkIndices": [
              14,
              13
            ]
          },
          {
            "segment": {
              "startIndex": 4559,
              "endIndex": 4637,
              "text": "However, prices can go up for more advanced features, automation, and AI tools"
            },
            "groundingChunkIndices": [
              0,
              15
            ]
          },
          {
            "segment": {
              "startIndex": 4639,
              "endIndex": 4808,
              "text": "Some CRMs offer free tiers (like HubSpot and Zoho CRM) which can be a good starting point to establish the habit of tracking relationships before upgrading to paid plans"
            },
            "groundingChunkIndices": [
              0,
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 4810,
              "endIndex": 5014,
              "text": "It's important to consider not just the per-user monthly fee but also potential setup fees, add-ons for advanced features, and the overall value the CRM provides in terms of increased sales and efficiency"
            },
            "groundingChunkIndices": [
              14,
              13,
              15
            ]
          }
        ],
        "webSearchQueries": [
          "best CRM tools for 50 person startup",
          "CRM for growing startups",
          "scalable CRM solutions for small businesses",
          "CRM features for sales and marketing teams",
          "CRM pricing for startups"
        ]
      }
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 16,
    "candidatesTokenCount": 1017,
    "totalTokenCount": 1577,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 16
      }
    ],
    "toolUsePromptTokenCount": 233,
    "toolUsePromptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 233
      }
    ],
    "thoughtsTokenCount": 311,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "aT3GasbrN9vDg8UP-dikiAQ"
};

export const noModelVersion = {
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "For a 50-person startup, the \"best\" CRM tools are typically those that offer scalability, essential features for a growing team, ease of use, integration capabilities, and flexible pricing. These tools should centralize customer data, streamline sales and marketing efforts, and provide insights to support continued growth.\n\nHere are some of the best CRM tools for a 50-person startup:\n\n*   **HubSpot CRM**: Often praised for its user-friendliness and generous free tier, HubSpot is ideal for marketing-led startups seeking a unified platform for sales and marketing workflows. It provides a solid foundation for contact management, deal tracking, email marketing, and basic reporting, with a clear upgrade path as the company scales. While its free and starter tiers have basic automation and reporting, it's a strong fit for teams prioritizing ease of use and future expansion into a broader revenue platform.\n*   **Zoho CRM**: This platform is a strong contender for startups and small to medium-sized businesses looking for a feature-rich CRM at an affordable price. Zoho CRM covers core functionalities like lead, contact, account, and deal management, along with tasks, events, and reports. It also offers advanced features such as AI-assisted insights, custom modules, and process automation, which can support more complex sales operations without requiring a switch to a different platform. However, its extensive features might require more setup time for smaller teams.\n*   **Pipedrive**: Best suited for sales-led startups, Pipedrive excels in pipeline management with a highly visual and intuitive interface. It helps sales teams efficiently track deals, manage activities, and move opportunities forward. Its focus on usability and activity-based sales management allows for quick adoption and helps teams concentrate on selling. Pipedrive is particularly beneficial for those who prioritize a straightforward, deal-focused CRM without extensive marketing or service capabilities.\n*   **Salesforce Starter Suite**: As a robust CRM platform, Salesforce offers a Starter Suite designed to be more accessible for startups with aggressive growth plans. It provides powerful automation, AI tools, and extensive integration options, making it suitable for teams that anticipate rapid scaling and may eventually require enterprise-grade features. While it may have a steeper learning curve, the benefits of advanced customization and its comprehensive ecosystem can be significant for technically inclined teams.\n*   **Conduyt**: This CRM aims to be a solution that startups can adopt once and grow with, avoiding the need for future migrations due to scaling costs or feature limitations. It offers a flat monthly rate regardless of the number of users, which can be highly advantageous for a 50-person startup with plans for further expansion. Conduyt emphasizes quick operational setup, real automation out-of-the-box (including lead routing and follow-up sequences), and native AI features.\n\n**Key CRM Features for a 50-Person Startup:**\n\nWhen selecting a CRM, a 50-person startup should prioritize the following features:\n\n*   **Contact and Activity Management**: A centralized database to store and organize all lead, customer, and conversation data, with automatic updates for emails, calls, and meetings.\n*   **Lead and Deal Management**: Tools to help identify leads, track their progress through the sales pipeline, and manage sales opportunities.\n*   **Automation and Workflows**: Capabilities to automate repetitive tasks such as data entry, follow-up reminders, and email sequences, allowing the team to focus on higher-value activities.\n*   **Reporting and Analytics**: Features that provide insights into sales performance, customer behavior, and marketing campaign effectiveness through customizable dashboards and reports.\n*   **Scalability**: The ability of the CRM to grow with the company, accommodating more users, data, and advanced functionalities without compromising performance or requiring a complete system overhaul.\n*   **Integration Capabilities**: Seamless integration with other essential business tools like email platforms, accounting software, and marketing apps.\n*   **Mobile Access**: Functionality that allows team members to access and update CRM information from anywhere, supporting remote or on-the-go work.\n\n**Pricing Considerations:**\n\nFor a startup, CRM costs can range significantly. Many small businesses, including those with around 50 employees, typically spend between $10 and $50 per user per month. However, prices can go up for more advanced features, automation, and AI tools. Some CRMs offer free tiers (like HubSpot and Zoho CRM) which can be a good starting point to establish the habit of tracking relationships before upgrading to paid plans. It's important to consider not just the per-user monthly fee but also potential setup fees, add-ons for advanced features, and the overall value the CRM provides in terms of increased sales and efficiency."
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0,
      "groundingMetadata": {
        "searchEntryPoint": {
          "renderedContent": "<style>\n.container {\n  align-items: center;\n  border-radius: 8px;\n  display: flex;\n  font-family: Google Sans, Roboto, sans-serif;\n  font-size: 14px;\n  line-height: 20px;\n  padding: 8px 12px;\n}\n.chip {\n  display: inline-block;\n  border: solid 1px;\n  border-radius: 16px;\n  min-width: 14px;\n  padding: 5px 16px;\n  text-align: center;\n  user-select: none;\n  margin: 0 8px;\n  -webkit-tap-highlight-color: transparent;\n}\n.carousel {\n  overflow: auto;\n  scrollbar-width: none;\n  white-space: nowrap;\n  margin-right: -12px;\n}\n.headline {\n  display: flex;\n  margin-right: 4px;\n}\n.gradient-container {\n  position: relative;\n}\n.gradient {\n  position: absolute;\n  transform: translate(3px, -9px);\n  height: 36px;\n  width: 9px;\n}\n@media (prefers-color-scheme: light) {\n  .container {\n    background-color: #fafafa;\n    box-shadow: 0 0 0 1px #0000000f;\n  }\n  .headline-label {\n    color: #1f1f1f;\n  }\n  .chip {\n    background-color: #ffffff;\n    border-color: #d2d2d2;\n    color: #5e5e5e;\n    text-decoration: none;\n  }\n  .chip:hover {\n    background-color: #f2f2f2;\n  }\n  .chip:focus {\n    background-color: #f2f2f2;\n  }\n  .chip:active {\n    background-color: #d8d8d8;\n    border-color: #b6b6b6;\n  }\n  .logo-dark {\n    display: none;\n  }\n  .gradient {\n    background: linear-gradient(90deg, #fafafa 15%, #fafafa00 100%);\n  }\n}\n@media (prefers-color-scheme: dark) {\n  .container {\n    background-color: #1f1f1f;\n    box-shadow: 0 0 0 1px #ffffff26;\n  }\n  .headline-label {\n    color: #fff;\n  }\n  .chip {\n    background-color: #2c2c2c;\n    border-color: #3c4043;\n    color: #fff;\n    text-decoration: none;\n  }\n  .chip:hover {\n    background-color: #353536;\n  }\n  .chip:focus {\n    background-color: #353536;\n  }\n  .chip:active {\n    background-color: #464849;\n    border-color: #53575b;\n  }\n  .logo-light {\n    display: none;\n  }\n  .gradient {\n    background: linear-gradient(90deg, #1f1f1f 15%, #1f1f1f00 100%);\n  }\n}\n</style>\n<div class=\"container\">\n  <div class=\"headline\">\n    <svg class=\"logo-light\" width=\"18\" height=\"18\" viewBox=\"9 9 35 35\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M42.8622 27.0064C42.8622 25.7839 42.7525 24.6084 42.5487 23.4799H26.3109V30.1568H35.5897C35.1821 32.3041 33.9596 34.1222 32.1258 35.3448V39.6864H37.7213C40.9814 36.677 42.8622 32.2571 42.8622 27.0064V27.0064Z\" fill=\"#4285F4\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 43.8555C30.9659 43.8555 34.8687 42.3195 37.7213 39.6863L32.1258 35.3447C30.5898 36.3792 28.6306 37.0061 26.3109 37.0061C21.8282 37.0061 18.0195 33.9811 16.6559 29.906H10.9194V34.3573C13.7563 39.9841 19.5712 43.8555 26.3109 43.8555V43.8555Z\" fill=\"#34A853\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M16.6559 29.8904C16.3111 28.8559 16.1074 27.7588 16.1074 26.6146C16.1074 25.4704 16.3111 24.3733 16.6559 23.3388V18.8875H10.9194C9.74388 21.2072 9.06992 23.8247 9.06992 26.6146C9.06992 29.4045 9.74388 32.022 10.9194 34.3417L15.3864 30.8621L16.6559 29.8904V29.8904Z\" fill=\"#FBBC05\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 16.2386C28.85 16.2386 31.107 17.1164 32.9095 18.8091L37.8466 13.8719C34.853 11.082 30.9659 9.3736 26.3109 9.3736C19.5712 9.3736 13.7563 13.245 10.9194 18.8875L16.6559 23.3388C18.0195 19.2636 21.8282 16.2386 26.3109 16.2386V16.2386Z\" fill=\"#EA4335\"/>\n    </svg>\n    <svg class=\"logo-dark\" width=\"18\" height=\"18\" viewBox=\"0 0 48 48\" xmlns=\"http://www.w3.org/2000/svg\">\n      <circle cx=\"24\" cy=\"23\" fill=\"#FFF\" r=\"22\"/>\n      <path d=\"M33.76 34.26c2.75-2.56 4.49-6.37 4.49-11.26 0-.89-.08-1.84-.29-3H24.01v5.99h8.03c-.4 2.02-1.5 3.56-3.07 4.56v.75l3.91 2.97h.88z\" fill=\"#4285F4\"/>\n      <path d=\"M15.58 25.77A8.845 8.845 0 0 0 24 31.86c1.92 0 3.62-.46 4.97-1.31l4.79 3.71C31.14 36.7 27.65 38 24 38c-5.93 0-11.01-3.4-13.45-8.36l.17-1.01 4.06-2.85h.8z\" fill=\"#34A853\"/>\n      <path d=\"M15.59 20.21a8.864 8.864 0 0 0 0 5.58l-5.03 3.86c-.98-2-1.53-4.25-1.53-6.64 0-2.39.55-4.64 1.53-6.64l1-.22 3.81 2.98.22 1.08z\" fill=\"#FBBC05\"/>\n      <path d=\"M24 14.14c2.11 0 4.02.75 5.52 1.98l4.36-4.36C31.22 9.43 27.81 8 24 8c-5.93 0-11.01 3.4-13.45 8.36l5.03 3.85A8.86 8.86 0 0 1 24 14.14z\" fill=\"#EA4335\"/>\n    </svg>\n    <div class=\"gradient-container\"><div class=\"gradient\"></div></div>\n  </div>\n  <div class=\"carousel\">\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aa\">CRM for growing startups</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ab\">best CRM tools for 50 person startup</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ac\">scalable CRM solutions for small businesses</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ad\">CRM pricing for startups</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ae\">CRM features for sales and marketing teams</a>\n  </div>\n</div>\n"
        },
        "groundingChunks": [
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-af",
              "title": "markestac.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ag",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ah",
              "title": "monday.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ai",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aj",
              "title": "quickbase.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ak",
              "title": "baserow.io"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-al",
              "title": "attio.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-am",
              "title": "bigcontacts.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-an",
              "title": "conduyt.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ao",
              "title": "uschamber.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ap",
              "title": "salesflare.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aq",
              "title": "fayedigital.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ar",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-as",
              "title": "nimble.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-at",
              "title": "zeeg.me"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-au",
              "title": "creatio.com"
            }
          }
        ],
        "groundingSupports": [
          {
            "segment": {
              "startIndex": 190,
              "endIndex": 323,
              "text": "These tools should centralize customer data, streamline sales and marketing efforts, and provide insights to support continued growth"
            },
            "groundingChunkIndices": [
              0,
              1,
              2,
              3
            ]
          },
          {
            "segment": {
              "startIndex": 388,
              "endIndex": 577,
              "text": "*   **HubSpot CRM**: Often praised for its user-friendliness and generous free tier, HubSpot is ideal for marketing-led startups seeking a unified platform for sales and marketing workflows"
            },
            "groundingChunkIndices": [
              4,
              5,
              2,
              6
            ]
          },
          {
            "segment": {
              "startIndex": 579,
              "endIndex": 734,
              "text": "It provides a solid foundation for contact management, deal tracking, email marketing, and basic reporting, with a clear upgrade path as the company scales"
            },
            "groundingChunkIndices": [
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 736,
              "endIndex": 911,
              "text": "While its free and starter tiers have basic automation and reporting, it's a strong fit for teams prioritizing ease of use and future expansion into a broader revenue platform"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 913,
              "endIndex": 1070,
              "text": "*   **Zoho CRM**: This platform is a strong contender for startups and small to medium-sized businesses looking for a feature-rich CRM at an affordable price"
            },
            "groundingChunkIndices": [
              4,
              5,
              2
            ]
          },
          {
            "segment": {
              "startIndex": 1198,
              "endIndex": 1399,
              "text": "It also offers advanced features such as AI-assisted insights, custom modules, and process automation, which can support more complex sales operations without requiring a switch to a different platform"
            },
            "groundingChunkIndices": [
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 1401,
              "endIndex": 1480,
              "text": "However, its extensive features might require more setup time for smaller teams"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1482,
              "endIndex": 1621,
              "text": "*   **Pipedrive**: Best suited for sales-led startups, Pipedrive excels in pipeline management with a highly visual and intuitive interface"
            },
            "groundingChunkIndices": [
              4,
              2,
              6,
              7
            ]
          },
          {
            "segment": {
              "startIndex": 1720,
              "endIndex": 1843,
              "text": "Its focus on usability and activity-based sales management allows for quick adoption and helps teams concentrate on selling"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1845,
              "endIndex": 1994,
              "text": "Pipedrive is particularly beneficial for those who prioritize a straightforward, deal-focused CRM without extensive marketing or service capabilities"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1996,
              "endIndex": 2162,
              "text": "*   **Salesforce Starter Suite**: As a robust CRM platform, Salesforce offers a Starter Suite designed to be more accessible for startups with aggressive growth plans"
            },
            "groundingChunkIndices": [
              5
            ]
          },
          {
            "segment": {
              "startIndex": 2164,
              "endIndex": 2353,
              "text": "It provides powerful automation, AI tools, and extensive integration options, making it suitable for teams that anticipate rapid scaling and may eventually require enterprise-grade features"
            },
            "groundingChunkIndices": [
              5,
              2,
              6,
              7
            ]
          },
          {
            "segment": {
              "startIndex": 2355,
              "endIndex": 2519,
              "text": "While it may have a steeper learning curve, the benefits of advanced customization and its comprehensive ecosystem can be significant for technically inclined teams"
            },
            "groundingChunkIndices": [
              5,
              6
            ]
          },
          {
            "segment": {
              "startIndex": 2521,
              "endIndex": 2696,
              "text": "*   **Conduyt**: This CRM aims to be a solution that startups can adopt once and grow with, avoiding the need for future migrations due to scaling costs or feature limitations"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 2698,
              "endIndex": 2852,
              "text": "It offers a flat monthly rate regardless of the number of users, which can be highly advantageous for a 50-person startup with plans for further expansion"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 2854,
              "endIndex": 3001,
              "text": "Conduyt emphasizes quick operational setup, real automation out-of-the-box (including lead routing and follow-up sequences), and native AI features"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 3136,
              "endIndex": 3319,
              "text": "*   **Contact and Activity Management**: A centralized database to store and organize all lead, customer, and conversation data, with automatic updates for emails, calls, and meetings"
            },
            "groundingChunkIndices": [
              1,
              9,
              10,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 3321,
              "endIndex": 3464,
              "text": "*   **Lead and Deal Management**: Tools to help identify leads, track their progress through the sales pipeline, and manage sales opportunities"
            },
            "groundingChunkIndices": [
              1,
              9,
              10
            ]
          },
          {
            "segment": {
              "startIndex": 3466,
              "endIndex": 3657,
              "text": "*   **Automation and Workflows**: Capabilities to automate repetitive tasks such as data entry, follow-up reminders, and email sequences, allowing the team to focus on higher-value activities"
            },
            "groundingChunkIndices": [
              1,
              10,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 3659,
              "endIndex": 3846,
              "text": "*   **Reporting and Analytics**: Features that provide insights into sales performance, customer behavior, and marketing campaign effectiveness through customizable dashboards and reports"
            },
            "groundingChunkIndices": [
              1,
              9,
              10,
              12
            ]
          },
          {
            "segment": {
              "startIndex": 3848,
              "endIndex": 4051,
              "text": "*   **Scalability**: The ability of the CRM to grow with the company, accommodating more users, data, and advanced functionalities without compromising performance or requiring a complete system overhaul"
            },
            "groundingChunkIndices": [
              1,
              3
            ]
          },
          {
            "segment": {
              "startIndex": 4053,
              "endIndex": 4205,
              "text": "*   **Integration Capabilities**: Seamless integration with other essential business tools like email platforms, accounting software, and marketing apps"
            },
            "groundingChunkIndices": [
              13,
              10
            ]
          },
          {
            "segment": {
              "startIndex": 4207,
              "endIndex": 4356,
              "text": "*   **Mobile Access**: Functionality that allows team members to access and update CRM information from anywhere, supporting remote or on-the-go work"
            },
            "groundingChunkIndices": [
              10,
              12,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 4438,
              "endIndex": 4557,
              "text": "Many small businesses, including those with around 50 employees, typically spend between $10 and $50 per user per month"
            },
            "groundingChunkIndices": [
              14,
              13
            ]
          },
          {
            "segment": {
              "startIndex": 4559,
              "endIndex": 4637,
              "text": "However, prices can go up for more advanced features, automation, and AI tools"
            },
            "groundingChunkIndices": [
              0,
              15
            ]
          },
          {
            "segment": {
              "startIndex": 4639,
              "endIndex": 4808,
              "text": "Some CRMs offer free tiers (like HubSpot and Zoho CRM) which can be a good starting point to establish the habit of tracking relationships before upgrading to paid plans"
            },
            "groundingChunkIndices": [
              0,
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 4810,
              "endIndex": 5014,
              "text": "It's important to consider not just the per-user monthly fee but also potential setup fees, add-ons for advanced features, and the overall value the CRM provides in terms of increased sales and efficiency"
            },
            "groundingChunkIndices": [
              14,
              13,
              15
            ]
          }
        ],
        "webSearchQueries": [
          "best CRM tools for 50 person startup",
          "CRM for growing startups",
          "scalable CRM solutions for small businesses",
          "CRM features for sales and marketing teams",
          "CRM pricing for startups"
        ]
      }
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 16,
    "candidatesTokenCount": 1017,
    "totalTokenCount": 1577,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 16
      }
    ],
    "toolUsePromptTokenCount": 233,
    "toolUsePromptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 233
      }
    ],
    "thoughtsTokenCount": 311,
    "serviceTier": "standard"
  },
  "responseId": "aT3GasbrN9vDg8UP-dikiAQ"
};

export const refusalSafety = {
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "text": "I can't help with that request."
          }
        ]
      },
      "finishReason": "SAFETY",
      "index": 0,
      "safetyRatings": [
        {
          "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
          "probability": "HIGH",
          "blocked": true
        }
      ]
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 16,
    "candidatesTokenCount": 8,
    "totalTokenCount": 24,
    "thoughtsTokenCount": 0
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "recorded-refusal-0001"
};

export const emptyAnswer = {
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "text": ""
          }
        ]
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 16,
    "candidatesTokenCount": 0,
    "totalTokenCount": 136,
    "thoughtsTokenCount": 120
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "recorded-empty-0001"
};

export const truncatedMaxTokens = {
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "For a 50-person startup, the \"best\" CRM tools are typically those that offer scalability, essential features for a growing team, ease of use, integration capabilities, and flexible pricing. These tools should centralize customer data, streamline sales and marketing efforts, and provide insights to support continued growth.\n\nHere are some of the best CRM tools for a 50-person startup:\n\n*   **HubSpot CRM**: Often praised for its user-friendliness and generous free tier, HubSpot is ideal for marketing-led startups seeking a unified platform for sales and marketing workflows. It provides a solid foundation for contact management, deal tracking, email marketing, and basic reporting, with a clear upgrade path as the company scales. While its free and starter tiers have basic automation and reporting, it's a strong fit for teams prioritizing ease of use and future expansion into a broader revenue platform.\n*   **Zoho CRM**: This platform is a strong contender for startups and small to medium-sized businesses looking for a feature-rich CRM at an affordable price. Zoho CRM covers core functionalities like lead, contact, account, and deal management, along with tasks, events, and reports. It also offers advanced features such as AI-assisted insights, custom modules, and process automation, which can support more complex sales operations without requiring a switch to a different platform. However, its extensive features might require more setup time for smaller teams.\n*   **Pipedrive**: Best suited for sales-led startups, Pipedrive excels in pipeline management with a highly visual and intuitive interface. It helps sales teams efficiently track deals, manage activities, and move opportunities forward. Its focus on usability and activity-based sales management allows for quick adoption and helps teams concentrate on selling. Pipedrive is particularly beneficial for those who prioritize a straightforward, deal-focused CRM without extensive marketing or service capabilities.\n*   **Salesforce Starter Suite**: As a robust CRM platform, Salesforce offers a Starter Suite designed to be more accessible for startups with aggressive growth plans. It provides powerful automation, AI tools, and extensive integration options, making it suitable for teams that anticipate rapid scaling and may eventually require enterprise-grade features. While it may have a steeper learning curve, the benefits of advanced customization and its comprehensive ecosystem can be significant for technically inclined teams.\n*   **Conduyt**: This CRM aims to be a solution that startups can adopt once and grow with, avoiding the need for future migrations due to scaling costs or feature limitations. It offers a flat monthly rate regardless of the number of users, which can be highly advantageous for a 50-person startup with plans for further expansion. Conduyt emphasizes quick operational setup, real automation out-of-the-box (including lead routing and follow-up sequences), and native AI features.\n\n**Key CRM Features for a 50-Person Startup:**\n\nWhen selecting a CRM, a 50-person startup should prioritize the following features:\n\n*   **Contact and Activity Management**: A centralized database to store and organize all lead, customer, and conversation data, with automatic updates for emails, calls, and meetings.\n*   **Lead and Deal Management**: Tools to help identify leads, track their progress through the sales pipeline, and manage sales opportunities.\n*   **Automation and Workflows**: Capabilities to automate repetitive tasks such as data entry, follow-up reminders, and email sequences, allowing the team to focus on higher-value activities.\n*   **Reporting and Analytics**: Features that provide insights into sales performance, customer behavior, and marketing campaign effectiveness through customizable dashboards and reports.\n*   **Scalability**: The ability of the CRM to grow with the company, accommodating more users, data, and advanced functionalities without compromising performance or requiring a complete system overhaul.\n*   **Integration Capabilities**: Seamless integration with other essential business tools like email platforms, accounting software, and marketing apps.\n*   **Mobile Access**: Functionality that allows team members to access and update CRM information from anywhere, supporting remote or on-the-go work.\n\n**Pricing Considerations:**\n\nFor a startup, CRM costs can range significantly. Many small businesses, including those with around 50 employees, typically spend between $10 and $50 per user per month. However, prices can go up for more advanced features, automation, and AI tools. Some CRMs offer free tiers (like HubSpot and Zoho CRM) which can be a good starting point to establish the habit of tracking relationships before upgrading to paid plans. It's important to consider not just the per-user monthly fee but also potential setup fees, add-ons for advanced features, and the overall value the CRM provides in terms of increased sales and efficiency."
          }
        ],
        "role": "model"
      },
      "finishReason": "MAX_TOKENS",
      "index": 0,
      "groundingMetadata": {
        "searchEntryPoint": {
          "renderedContent": "<style>\n.container {\n  align-items: center;\n  border-radius: 8px;\n  display: flex;\n  font-family: Google Sans, Roboto, sans-serif;\n  font-size: 14px;\n  line-height: 20px;\n  padding: 8px 12px;\n}\n.chip {\n  display: inline-block;\n  border: solid 1px;\n  border-radius: 16px;\n  min-width: 14px;\n  padding: 5px 16px;\n  text-align: center;\n  user-select: none;\n  margin: 0 8px;\n  -webkit-tap-highlight-color: transparent;\n}\n.carousel {\n  overflow: auto;\n  scrollbar-width: none;\n  white-space: nowrap;\n  margin-right: -12px;\n}\n.headline {\n  display: flex;\n  margin-right: 4px;\n}\n.gradient-container {\n  position: relative;\n}\n.gradient {\n  position: absolute;\n  transform: translate(3px, -9px);\n  height: 36px;\n  width: 9px;\n}\n@media (prefers-color-scheme: light) {\n  .container {\n    background-color: #fafafa;\n    box-shadow: 0 0 0 1px #0000000f;\n  }\n  .headline-label {\n    color: #1f1f1f;\n  }\n  .chip {\n    background-color: #ffffff;\n    border-color: #d2d2d2;\n    color: #5e5e5e;\n    text-decoration: none;\n  }\n  .chip:hover {\n    background-color: #f2f2f2;\n  }\n  .chip:focus {\n    background-color: #f2f2f2;\n  }\n  .chip:active {\n    background-color: #d8d8d8;\n    border-color: #b6b6b6;\n  }\n  .logo-dark {\n    display: none;\n  }\n  .gradient {\n    background: linear-gradient(90deg, #fafafa 15%, #fafafa00 100%);\n  }\n}\n@media (prefers-color-scheme: dark) {\n  .container {\n    background-color: #1f1f1f;\n    box-shadow: 0 0 0 1px #ffffff26;\n  }\n  .headline-label {\n    color: #fff;\n  }\n  .chip {\n    background-color: #2c2c2c;\n    border-color: #3c4043;\n    color: #fff;\n    text-decoration: none;\n  }\n  .chip:hover {\n    background-color: #353536;\n  }\n  .chip:focus {\n    background-color: #353536;\n  }\n  .chip:active {\n    background-color: #464849;\n    border-color: #53575b;\n  }\n  .logo-light {\n    display: none;\n  }\n  .gradient {\n    background: linear-gradient(90deg, #1f1f1f 15%, #1f1f1f00 100%);\n  }\n}\n</style>\n<div class=\"container\">\n  <div class=\"headline\">\n    <svg class=\"logo-light\" width=\"18\" height=\"18\" viewBox=\"9 9 35 35\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M42.8622 27.0064C42.8622 25.7839 42.7525 24.6084 42.5487 23.4799H26.3109V30.1568H35.5897C35.1821 32.3041 33.9596 34.1222 32.1258 35.3448V39.6864H37.7213C40.9814 36.677 42.8622 32.2571 42.8622 27.0064V27.0064Z\" fill=\"#4285F4\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 43.8555C30.9659 43.8555 34.8687 42.3195 37.7213 39.6863L32.1258 35.3447C30.5898 36.3792 28.6306 37.0061 26.3109 37.0061C21.8282 37.0061 18.0195 33.9811 16.6559 29.906H10.9194V34.3573C13.7563 39.9841 19.5712 43.8555 26.3109 43.8555V43.8555Z\" fill=\"#34A853\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M16.6559 29.8904C16.3111 28.8559 16.1074 27.7588 16.1074 26.6146C16.1074 25.4704 16.3111 24.3733 16.6559 23.3388V18.8875H10.9194C9.74388 21.2072 9.06992 23.8247 9.06992 26.6146C9.06992 29.4045 9.74388 32.022 10.9194 34.3417L15.3864 30.8621L16.6559 29.8904V29.8904Z\" fill=\"#FBBC05\"/>\n      <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 16.2386C28.85 16.2386 31.107 17.1164 32.9095 18.8091L37.8466 13.8719C34.853 11.082 30.9659 9.3736 26.3109 9.3736C19.5712 9.3736 13.7563 13.245 10.9194 18.8875L16.6559 23.3388C18.0195 19.2636 21.8282 16.2386 26.3109 16.2386V16.2386Z\" fill=\"#EA4335\"/>\n    </svg>\n    <svg class=\"logo-dark\" width=\"18\" height=\"18\" viewBox=\"0 0 48 48\" xmlns=\"http://www.w3.org/2000/svg\">\n      <circle cx=\"24\" cy=\"23\" fill=\"#FFF\" r=\"22\"/>\n      <path d=\"M33.76 34.26c2.75-2.56 4.49-6.37 4.49-11.26 0-.89-.08-1.84-.29-3H24.01v5.99h8.03c-.4 2.02-1.5 3.56-3.07 4.56v.75l3.91 2.97h.88z\" fill=\"#4285F4\"/>\n      <path d=\"M15.58 25.77A8.845 8.845 0 0 0 24 31.86c1.92 0 3.62-.46 4.97-1.31l4.79 3.71C31.14 36.7 27.65 38 24 38c-5.93 0-11.01-3.4-13.45-8.36l.17-1.01 4.06-2.85h.8z\" fill=\"#34A853\"/>\n      <path d=\"M15.59 20.21a8.864 8.864 0 0 0 0 5.58l-5.03 3.86c-.98-2-1.53-4.25-1.53-6.64 0-2.39.55-4.64 1.53-6.64l1-.22 3.81 2.98.22 1.08z\" fill=\"#FBBC05\"/>\n      <path d=\"M24 14.14c2.11 0 4.02.75 5.52 1.98l4.36-4.36C31.22 9.43 27.81 8 24 8c-5.93 0-11.01 3.4-13.45 8.36l5.03 3.85A8.86 8.86 0 0 1 24 14.14z\" fill=\"#EA4335\"/>\n    </svg>\n    <div class=\"gradient-container\"><div class=\"gradient\"></div></div>\n  </div>\n  <div class=\"carousel\">\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aa\">CRM for growing startups</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ab\">best CRM tools for 50 person startup</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ac\">scalable CRM solutions for small businesses</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ad\">CRM pricing for startups</a>\n    <a class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ae\">CRM features for sales and marketing teams</a>\n  </div>\n</div>\n"
        },
        "groundingChunks": [
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-af",
              "title": "markestac.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ag",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ah",
              "title": "monday.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ai",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aj",
              "title": "quickbase.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ak",
              "title": "baserow.io"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-al",
              "title": "attio.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-am",
              "title": "bigcontacts.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-an",
              "title": "conduyt.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ao",
              "title": "uschamber.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ap",
              "title": "salesflare.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-aq",
              "title": "fayedigital.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-ar",
              "title": "salesforce.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-as",
              "title": "nimble.com"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-at",
              "title": "zeeg.me"
            }
          },
          {
            "web": {
              "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token-au",
              "title": "creatio.com"
            }
          }
        ],
        "groundingSupports": [
          {
            "segment": {
              "startIndex": 190,
              "endIndex": 323,
              "text": "These tools should centralize customer data, streamline sales and marketing efforts, and provide insights to support continued growth"
            },
            "groundingChunkIndices": [
              0,
              1,
              2,
              3
            ]
          },
          {
            "segment": {
              "startIndex": 388,
              "endIndex": 577,
              "text": "*   **HubSpot CRM**: Often praised for its user-friendliness and generous free tier, HubSpot is ideal for marketing-led startups seeking a unified platform for sales and marketing workflows"
            },
            "groundingChunkIndices": [
              4,
              5,
              2,
              6
            ]
          },
          {
            "segment": {
              "startIndex": 579,
              "endIndex": 734,
              "text": "It provides a solid foundation for contact management, deal tracking, email marketing, and basic reporting, with a clear upgrade path as the company scales"
            },
            "groundingChunkIndices": [
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 736,
              "endIndex": 911,
              "text": "While its free and starter tiers have basic automation and reporting, it's a strong fit for teams prioritizing ease of use and future expansion into a broader revenue platform"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 913,
              "endIndex": 1070,
              "text": "*   **Zoho CRM**: This platform is a strong contender for startups and small to medium-sized businesses looking for a feature-rich CRM at an affordable price"
            },
            "groundingChunkIndices": [
              4,
              5,
              2
            ]
          },
          {
            "segment": {
              "startIndex": 1198,
              "endIndex": 1399,
              "text": "It also offers advanced features such as AI-assisted insights, custom modules, and process automation, which can support more complex sales operations without requiring a switch to a different platform"
            },
            "groundingChunkIndices": [
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 1401,
              "endIndex": 1480,
              "text": "However, its extensive features might require more setup time for smaller teams"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1482,
              "endIndex": 1621,
              "text": "*   **Pipedrive**: Best suited for sales-led startups, Pipedrive excels in pipeline management with a highly visual and intuitive interface"
            },
            "groundingChunkIndices": [
              4,
              2,
              6,
              7
            ]
          },
          {
            "segment": {
              "startIndex": 1720,
              "endIndex": 1843,
              "text": "Its focus on usability and activity-based sales management allows for quick adoption and helps teams concentrate on selling"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1845,
              "endIndex": 1994,
              "text": "Pipedrive is particularly beneficial for those who prioritize a straightforward, deal-focused CRM without extensive marketing or service capabilities"
            },
            "groundingChunkIndices": [
              4
            ]
          },
          {
            "segment": {
              "startIndex": 1996,
              "endIndex": 2162,
              "text": "*   **Salesforce Starter Suite**: As a robust CRM platform, Salesforce offers a Starter Suite designed to be more accessible for startups with aggressive growth plans"
            },
            "groundingChunkIndices": [
              5
            ]
          },
          {
            "segment": {
              "startIndex": 2164,
              "endIndex": 2353,
              "text": "It provides powerful automation, AI tools, and extensive integration options, making it suitable for teams that anticipate rapid scaling and may eventually require enterprise-grade features"
            },
            "groundingChunkIndices": [
              5,
              2,
              6,
              7
            ]
          },
          {
            "segment": {
              "startIndex": 2355,
              "endIndex": 2519,
              "text": "While it may have a steeper learning curve, the benefits of advanced customization and its comprehensive ecosystem can be significant for technically inclined teams"
            },
            "groundingChunkIndices": [
              5,
              6
            ]
          },
          {
            "segment": {
              "startIndex": 2521,
              "endIndex": 2696,
              "text": "*   **Conduyt**: This CRM aims to be a solution that startups can adopt once and grow with, avoiding the need for future migrations due to scaling costs or feature limitations"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 2698,
              "endIndex": 2852,
              "text": "It offers a flat monthly rate regardless of the number of users, which can be highly advantageous for a 50-person startup with plans for further expansion"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 2854,
              "endIndex": 3001,
              "text": "Conduyt emphasizes quick operational setup, real automation out-of-the-box (including lead routing and follow-up sequences), and native AI features"
            },
            "groundingChunkIndices": [
              8
            ]
          },
          {
            "segment": {
              "startIndex": 3136,
              "endIndex": 3319,
              "text": "*   **Contact and Activity Management**: A centralized database to store and organize all lead, customer, and conversation data, with automatic updates for emails, calls, and meetings"
            },
            "groundingChunkIndices": [
              1,
              9,
              10,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 3321,
              "endIndex": 3464,
              "text": "*   **Lead and Deal Management**: Tools to help identify leads, track their progress through the sales pipeline, and manage sales opportunities"
            },
            "groundingChunkIndices": [
              1,
              9,
              10
            ]
          },
          {
            "segment": {
              "startIndex": 3466,
              "endIndex": 3657,
              "text": "*   **Automation and Workflows**: Capabilities to automate repetitive tasks such as data entry, follow-up reminders, and email sequences, allowing the team to focus on higher-value activities"
            },
            "groundingChunkIndices": [
              1,
              10,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 3659,
              "endIndex": 3846,
              "text": "*   **Reporting and Analytics**: Features that provide insights into sales performance, customer behavior, and marketing campaign effectiveness through customizable dashboards and reports"
            },
            "groundingChunkIndices": [
              1,
              9,
              10,
              12
            ]
          },
          {
            "segment": {
              "startIndex": 3848,
              "endIndex": 4051,
              "text": "*   **Scalability**: The ability of the CRM to grow with the company, accommodating more users, data, and advanced functionalities without compromising performance or requiring a complete system overhaul"
            },
            "groundingChunkIndices": [
              1,
              3
            ]
          },
          {
            "segment": {
              "startIndex": 4053,
              "endIndex": 4205,
              "text": "*   **Integration Capabilities**: Seamless integration with other essential business tools like email platforms, accounting software, and marketing apps"
            },
            "groundingChunkIndices": [
              13,
              10
            ]
          },
          {
            "segment": {
              "startIndex": 4207,
              "endIndex": 4356,
              "text": "*   **Mobile Access**: Functionality that allows team members to access and update CRM information from anywhere, supporting remote or on-the-go work"
            },
            "groundingChunkIndices": [
              10,
              12,
              11
            ]
          },
          {
            "segment": {
              "startIndex": 4438,
              "endIndex": 4557,
              "text": "Many small businesses, including those with around 50 employees, typically spend between $10 and $50 per user per month"
            },
            "groundingChunkIndices": [
              14,
              13
            ]
          },
          {
            "segment": {
              "startIndex": 4559,
              "endIndex": 4637,
              "text": "However, prices can go up for more advanced features, automation, and AI tools"
            },
            "groundingChunkIndices": [
              0,
              15
            ]
          },
          {
            "segment": {
              "startIndex": 4639,
              "endIndex": 4808,
              "text": "Some CRMs offer free tiers (like HubSpot and Zoho CRM) which can be a good starting point to establish the habit of tracking relationships before upgrading to paid plans"
            },
            "groundingChunkIndices": [
              0,
              4,
              5
            ]
          },
          {
            "segment": {
              "startIndex": 4810,
              "endIndex": 5014,
              "text": "It's important to consider not just the per-user monthly fee but also potential setup fees, add-ons for advanced features, and the overall value the CRM provides in terms of increased sales and efficiency"
            },
            "groundingChunkIndices": [
              14,
              13,
              15
            ]
          }
        ],
        "webSearchQueries": [
          "best CRM tools for 50 person startup",
          "CRM for growing startups",
          "scalable CRM solutions for small businesses",
          "CRM features for sales and marketing teams",
          "CRM pricing for startups"
        ]
      }
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 16,
    "candidatesTokenCount": 1017,
    "totalTokenCount": 1577,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 16
      }
    ],
    "toolUsePromptTokenCount": 233,
    "toolUsePromptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 233
      }
    ],
    "thoughtsTokenCount": 311,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "recorded-truncated-0001"
};

// Not a generateContent response at all: candidates is not an array and there is no usage.
export const malformedPayload = { candidates: "unexpected", modelVersion: 7 };

export const invalidKeyError = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
  },
};
