// STORY-029 - RECORDED SerpApi responses (serpapi.com), captured 2026-10-30 with one real key by scripts/record-serp-fixtures.mjs.
// Every file below is a real response, abridged where noted. Stripped before saving: search ids and endpoints, timestamps, the echoed
// search_parameters, and any account-identifying URL (serpapi.com/searches/<id>/ thumbnails carry the search id and are masked).
// Image URLs are replaced by a placeholder on the same host (the repo's brand-asset scan reads any image URL as a bundled logo). Opaque vendor tokens are shortened; they are expired by now and the code never decodes them. The query in each header is the one sent.
// Budget: the whole story spent 6 live searches; nothing in the test suite touches the network.

/** engine=google_ai_mode, q="best noise cancelling headphones under 100 dollars", live (no_cache=true). Text, a table, lists with inline shopping_result (price/rating/reviews), top-level shopping_results. */
export const aiModePriced: unknown = {
  "search_metadata": {
    "status": "Success"
  },
  "shopping_results": [
    {
      "title": "Soundcore Life Q30 by Anker",
      "product_link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462887977951291,imageDocid:17508826014207272230,gpcid:168455216098522800,headlineOfferDocid:16917759782074610490,catalogid:15027068778094995066,productDocid:18132781609728767484,rds:PC_168455216098522800%7CPROD_PC_168455216098522800&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
      "immersive_product_page_token": "s60pc3icbY5NTsMwEEYP-TRUNCATED",
      "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=s60pc3icbY5NTsMwEEYP-TRUNCATED",
      "serpapi_product_api": "https://serpapi.com/search.json?engine=google_product&page_token=s60pc3icbY5NTsMwEEYP-TRUNCATED",
      "thumbnail": "https://serpapi.com/REDACTED-image",
      "price": "$85.99",
      "extracted_price": 85.99,
      "source": "soundcore NA& more",
      "rating": 4.6,
      "reviews": 2200,
      "index": 0
    },
    {
      "title": "JLab JBuds Lux ANC",
      "product_link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462768183402495,imageDocid:3602113712907389807,gpcid:1698331967329665262,headlineOfferDocid:12185191750580024426,catalogid:2048947465217953597,productDocid:8139787361734834398,rds:PC_1698331967329665262%7CPROD_PC_1698331967329665262&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
      "immersive_product_page_token": "JC7ZtnicbZBNbsIwFIQP-TRUNCATED",
      "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=JC7ZtnicbZBNbsIwFIQP-TRUNCATED",
      "serpapi_product_api": "https://serpapi.com/search.json?engine=google_product&page_token=JC7ZtnicbZBNbsIwFIQP-TRUNCATED",
      "thumbnail": "https://serpapi.com/REDACTED-image",
      "price": "$39.99$85",
      "extracted_price": 39.99,
      "source": "Best Buy& more",
      "rating": 4.6,
      "reviews": 7500,
      "index": 1
    },
    {
      "title": "JBL Tune 780NC",
      "product_link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462900042129598,imageDocid:4545642008504167891,gpcid:3190701464784996572,headlineOfferDocid:15324287994433380357,catalogid:14889218957507998288,productDocid:4847594757674650042,rds:PC_3190701464784996572%7CPROD_PC_3190701464784996572&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
      "immersive_product_page_token": "Lm5UDHicbZCxbcMwFEQH-TRUNCATED",
      "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=Lm5UDHicbZCxbcMwFEQH-TRUNCATED",
      "serpapi_product_api": "https://serpapi.com/search.json?engine=google_product&page_token=Lm5UDHicbZCxbcMwFEQH-TRUNCATED",
      "thumbnail": "https://serpapi.com/REDACTED-image",
      "price": "$89.95$150",
      "extracted_price": 89.95,
      "source": "Best Buy& more",
      "rating": 4.6,
      "reviews": 776,
      "index": 2
    }
  ],
  "text_blocks": [
    {
      "type": "paragraph",
      "snippet": "The Soundcore Life Q30 by AnkerGo to product viewer dialog for this item. and the JLab JBuds Lux ANCGo to product viewer dialog for this item. rank as the best noise-cancelling headphones under $100, delivering hybrid active noise cancellation, long battery life, and comfortable over-ear builds without stretching your budget.",
      "snippet_links": [
        {
          "text": "Soundcore Life Q30 by AnkerGo to product viewer dialog for this item.",
          "link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462887977951291,imageDocid:17508826014207272230,gpcid:168455216098522800,headlineOfferDocid:16917759782074610490,catalogid:15027068778094995066,productDocid:18132781609728767484,rds:PC_168455216098522800%7CPROD_PC_168455216098522800&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
          "shopping_results_reference_index": 0
        },
        {
          "text": "JLab JBuds Lux ANCGo to product viewer dialog for this item.",
          "link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462768183402495,imageDocid:11154107875665096583,gpcid:1698331967329665262,headlineOfferDocid:9204848268937354025,catalogid:2048947465217953597,productDocid:8139787361734834398,rds:PC_1698331967329665262%7CPROD_PC_1698331967329665262&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED"
        }
      ],
      "snippet_highlighted_words": [
        "Soundcore Life Q30 by AnkerGo to product viewer dialog for this item. and the JLab JBuds Lux ANCGo to product viewer dialog for this item."
      ],
      "reference_indexes": [
        0,
        1
      ]
    },
    {
      "type": "heading",
      "snippet": "Top Noise-Cancelling Headphones Under $100"
    },
    {
      "type": "table",
      "table": [
        [
          "Headphone Model",
          "Best For",
          "Key ANC & Battery Specs",
          "Estimated Price"
        ],
        [
          "Soundcore Life Q30 by AnkerGo to product viewer dialog for this item.",
          "All-around performance & customizable EQ",
          "Hybrid ANC (up to 95% low-freq block), 50 hrs playtime (ANC on)",
          "Target"
        ],
        [
          "JLab JBuds Lux ANCGo to product viewer dialog for this item.",
          "Lightweight comfort & spatial audio",
          "Smart ANC (up to 35 dB), 70+ hrs battery, spatial audio",
          "Best Buy"
        ],
        [
          "JBL Tune 780NCGo to product viewer dialog for this item.",
          "Strong bass and multi-point pairing",
          "Adaptive ANC, up to 50 hrs playtime (ANC on), quick charge (5 min = 5 hrs)",
          "Best Buy"
        ],
        [
          "Soundcore Life Q20Go to product viewer dialog for this item.",
          "Tight budget value",
          "Hybrid ANC (reduces ambient noise up to 90%), 40 hrs playtime",
          "~$30 – $60"
        ]
      ],
      "detailed": [
        [
          {
            "snippet": "Headphone Model"
          },
          {
            "snippet": "Best For"
          },
          {
            "snippet": "Key ANC & Battery Specs"
          },
          {
            "snippet": "Estimated Price"
          }
        ],
        [
          {
            "snippet": "Soundcore Life Q30 by AnkerGo to product viewer dialog for this item."
          },
          {
            "snippet": "All-around performance & customizable EQ"
          },
          {
            "snippet": "Hybrid ANC (up to 95% low-freq block), 50 hrs playtime (ANC on)"
          },
          {
            "snippet": "Target"
          }
        ],
        [
          {
            "snippet": "JLab JBuds Lux ANCGo to product viewer dialog for this item."
          },
          {
            "snippet": "Lightweight comfort & spatial audio"
          },
          {
            "snippet": "Smart ANC (up to 35 dB), 70+ hrs battery, spatial audio"
          },
          {
            "snippet": "Best Buy"
          }
        ],
        [
          {
            "snippet": "JBL Tune 780NCGo to product viewer dialog for this item."
          },
          {
            "snippet": "Strong bass and multi-point pairing"
          },
          {
            "snippet": "Adaptive ANC, up to 50 hrs playtime (ANC on), quick charge (5 min = 5 hrs)"
          },
          {
            "snippet": "Best Buy"
          }
        ],
        [
          {
            "snippet": "Soundcore Life Q20Go to product viewer dialog for this item."
          },
          {
            "snippet": "Tight budget value"
          },
          {
            "snippet": "Hybrid ANC (reduces ambient noise up to 90%), 40 hrs playtime"
          },
          {
            "snippet": "~$30 – $60"
          }
        ]
      ],
      "formatted": [
        {
          "headphone_model": "Soundcore Life Q30 by AnkerGo to product viewer dialog for this item.",
          "best_for": "All-around performance & customizable EQ",
          "key_anc_battery_specs": "Hybrid ANC (up to 95% low-freq block), 50 hrs playtime (ANC on)",
          "estimated_price": "Target"
        },
        {
          "headphone_model": "JLab JBuds Lux ANCGo to product viewer dialog for this item.",
          "best_for": "Lightweight comfort & spatial audio",
          "key_anc_battery_specs": "Smart ANC (up to 35 dB), 70+ hrs battery, spatial audio",
          "estimated_price": "Best Buy"
        },
        {
          "headphone_model": "JBL Tune 780NCGo to product viewer dialog for this item.",
          "best_for": "Strong bass and multi-point pairing",
          "key_anc_battery_specs": "Adaptive ANC, up to 50 hrs playtime (ANC on), quick charge (5 min = 5 hrs)",
          "estimated_price": "Best Buy"
        },
        {
          "headphone_model": "Soundcore Life Q20Go to product viewer dialog for this item.",
          "best_for": "Tight budget value",
          "key_anc_battery_specs": "Hybrid ANC (reduces ambient noise up to 90%), 40 hrs playtime",
          "estimated_price": "~$30 – $60"
        }
      ]
    },
    {
      "type": "heading",
      "snippet": "Detailed Breakdown"
    },
    {
      "type": "list",
      "list": [
        {
          "shopping_result": {
            "title": "Soundcore Life Q30 by Anker",
            "product_link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462887977951291,imageDocid:17508826014207272230,gpcid:168455216098522800,headlineOfferDocid:16917759782074610490,catalogid:15027068778094995066,productDocid:18132781609728767484,rds:PC_168455216098522800%7CPROD_PC_168455216098522800&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
            "immersive_product_page_token": "s60pc3icbY5NTsMwEEYP-TRUNCATED",
            "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=s60pc3icbY5NTsMwEEYP-TRUNCATED",
            "serpapi_product_api": "https://serpapi.com/search.json?engine=google_product&page_token=s60pc3icbY5NTsMwEEYP-TRUNCATED",
            "thumbnail": "https://serpapi.com/REDACTED-image",
            "price": "$85.99",
            "extracted_price": 85.99,
            "source": "soundcore NA& more",
            "rating": 4.6,
            "reviews": 2200
          },
          "list": [
            {
              "snippet": "Noise Cancellation: Features multi-mode hybrid ANC (Transport, Outdoor, and Indoor modes) that effectively dampens airplane engines, traffic, and office chatter."
            },
            {
              "snippet": "Sound & Battery: Equipped with 40mm silk-diaphragm drivers and a companion app with deep EQ customization. Battery lasts up to 50 hours with ANC turned on (and up to 80 hours in standard mode)."
            }
          ]
        },
        {
          "shopping_result": {
            "title": "JLab JBuds Lux ANC",
            "product_link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462768183402495,imageDocid:3602113712907389807,gpcid:1698331967329665262,headlineOfferDocid:12185191750580024426,catalogid:2048947465217953597,productDocid:8139787361734834398,rds:PC_1698331967329665262%7CPROD_PC_1698331967329665262&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
            "immersive_product_page_token": "JC7ZtnicbZBNbsIwFIQP-TRUNCATED",
            "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=JC7ZtnicbZBNbsIwFIQP-TRUNCATED",
            "serpapi_product_api": "https://serpapi.com/search.json?engine=google_product&page_token=JC7ZtnicbZBNbsIwFIQP-TRUNCATED",
            "thumbnail": "https://serpapi.com/REDACTED-image",
            "price": "$39.99$85",
            "extracted_price": 39.99,
            "source": "Best Buy& more",
            "rating": 4.6,
            "reviews": 7500
          },
          "list": [
            {
              "snippet": "Noise Cancellation: Offers smart active noise cancellation blocking up to 35 dB of ambient clutter, alongside a \"Be Aware\" transparency mode."
            },
            {
              "snippet": "Sound & Battery: Features built-in spatial audio support, comfortable cloud-foam ear cushions, and an impressive 70+ hour total battery footprint."
            }
          ]
        },
        {
          "shopping_result": {
            "title": "JBL Tune 780NC",
            "product_link": "https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462900042129598,imageDocid:4545642008504167891,gpcid:3190701464784996572,headlineOfferDocid:15324287994433380357,catalogid:14889218957507998288,productDocid:4847594757674650042,rds:PC_3190701464784996572%7CPROD_PC_3190701464784996572&q=product&sa=X&ved=2ahUKEwi_i-W5i-GXAxU-TRUNCATED",
            "immersive_product_page_token": "Lm5UDHicbZCxbcMwFEQH-TRUNCATED",
            "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=Lm5UDHicbZCxbcMwFEQH-TRUNCATED",
            "serpapi_product_api": "https://serpapi.com/search.json?engine=google_product&page_token=Lm5UDHicbZCxbcMwFEQH-TRUNCATED",
            "thumbnail": "https://serpapi.com/REDACTED-image",
            "price": "$89.95$150",
            "extracted_price": 89.95,
            "source": "Best Buy& more",
            "rating": 4.6,
            "reviews": 776
          },
          "list": [
            {
              "snippet": "Noise Cancellation: Utilizes adaptive noise-cancelling with dedicated commuting and anti-wind modes."
            },
            {
              "snippet": "Sound & Battery: Delivers signature JBL Pure Bass sound, multi-point Bluetooth switching across two devices simultaneously, and up to 50 hours of playback with ANC active.",
              "reference_indexes": [
                0,
                1,
                2
              ]
            }
          ],
          "reference_indexes": [
            0,
            1,
            2
          ]
        }
      ]
    },
    {
      "type": "paragraph",
      "snippet": "Are you looking for over-ear or in-ear (earbuds) style, and will you mostly use them for travel, the gym, or quiet office work?"
    }
  ],
  "references": [
    {
      "index": 0,
      "title": "JLab JBuds Lux ANC Over-Ear Headphones",
      "link": "https://www.google.com/search?ibp=oshop&prds=pvt%3Ahg%2Cpvo%3A29%2Cproductid%3A8139787361734834398%2Ccatalogid%3A2048947465217953597%2Cgpcid%3A1698331967329665262%2Cmid%3A576462768183402495&q=product",
      "snippet": "You can enjoy music like you're actually there with the JBuds Lux ANC Gray. The headphones have spatial audio. With this technology, music sounds like it surrounds you. Want to enjoy music without hearing the people around you? That's possible with the active noise canceling. This technology reduces ambient noise, so you're less bothered by talking people in public transport. The cloud foam comfort ear cushions are made based on the shape of the ear. That way, the headphones are comfortable and you can listen to music or podcasts for a long time. You can adjust the sound to your wishes in the JLab app. You can amplify the bass when you clearly want to hear the beat, for example.",
      "source": "Google",
      "source_icon": "https://encrypted-tbn1.gstatic.com/faviconV2?url=https://www.google.com&client=AIM&size=32&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
      "thumbnail": "https://encrypted-tbn3.gstatic.com/images?q=tbn:ANd9GcSeNncGAaaMn1Z4-TRUNCATED"
    },
    {
      "index": 1,
      "title": "Soundcore Q30 by Anker",
      "link": "https://www.google.com/search?ibp=oshop&prds=pvt%3Ahg%2Cpvo%3A29%2Cproductid%3A8561437252339516764%2Ccatalogid%3A7136944671779279509%2Cgpcid%3A9164371928389566269&q=product",
      "snippet": "Stay focused with the Soundcore Q30 Wireless ANC Noise Cancelling Headphones in Black, designed with hybrid active noise cancellation to reduce distractions. These Soundcore Q30 headphones feature dual noise-detecting microphones on each side to block up to 95% of low-frequency sound. Choose from three noise cancellation modes to match your environment. Transport mode reduces airplane engine noise, Outdoor mode handles traffic and wind, while Indoor mode helps minimise background conversations. Please note that ANC is not supported when connected via AUX cable. Equipped with 40mm drivers and silk diaphragms, the Soundcore wireless headphones reproduce detailed mids and highs, while pre-tuned EQ presets enhance bass for a fuller sound. The Soundcore Q30 ANC headphones provide up to 50 hours of playtime in noise cancelling mode and up to 80 hours in standard mode. A quick 10-minute charge delivers up to 10 hours of listening time.",
      "source": "Google",
      "source_icon": "https://encrypted-tbn1.gstatic.com/faviconV2?url=https://www.google.com&client=AIM&size=32&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
      "thumbnail": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTzlosb9AyINLkq-TRUNCATED"
    },
    {
      "index": 2,
      "title": "JBL Tune 780NC Noise Cancelling Wireless Over-Ear Headphones",
      "link": "https://www.google.com/search?ibp=oshop&prds=pvt%3Ahg%2Cpvo%3A29%2Cproductid%3A4847594757674650042%2Ccatalogid%3A14889218957507998288%2Cgpcid%3A3190701464784996572%2Cmid%3A576462900042129598&q=product",
      "snippet": "Pure bass, noise free. Your music takes center stage with JBL Tune 780NC wireless headphones. JBL Pure Bass Sound and immersive Spatial Sound surround you with crisp, powerful music, while Adaptive Noise Cancelling keeps you free from distractions. The sleek over-ear design with subtle metal accents makes a statement in your choice of stylish colors. Up to 76 hours of battery life means you can go a week between charges. And if you do need a top-up, five minutes gets you another 5 hours-or just plug in the detachable headphone cable to stay in the groove. With 2 mics that accurately pick-up your voice, calls sound perfect on both ends. Seamless Bluetooth switching makes it easy to stay connected across devices, while the JBL Headphones app lets you tailor the sound of your music and crystal-clear calls with ease. They're lightweight enough to wear all day, and foldable so they slip easily into any bag when the music's over. From morning podcasts to all-night playlists, JBL Tune 780NC headphones are built to keep up and stand out.",
      "source": "Google",
      "source_icon": "https://encrypted-tbn1.gstatic.com/faviconV2?url=https://www.google.com&client=AIM&size=32&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
      "thumbnail": "https://encrypted-tbn3.gstatic.com/images?q=tbn:ANd9GcT1zX-xhC8tP_Ys-TRUNCATED"
    }
  ],
  "reconstructed_markdown": "The [Soundcore Life Q30 by AnkerGo to product viewer dialog for this item.](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462887977951291,imageDocid:17508826014207272230,gpcid:168455216098522800,headlineOfferDocid:16917759782074610490,catalogid:15027068778094995066,productDocid:18132781609728767484,rds:PC_168455216098522800%7CPROD_PC_168455216098522800&q=product) and the [JLab JBuds Lux ANCGo to product viewer dialog for this item.](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462768183402495,imageDocid:11154107875665096583,gpcid:1698331967329665262,headlineOfferDocid:9204848268937354025,catalogid:2048947465217953597,productDocid:8139787361734834398,rds:PC_1698331967329665262%7CPROD_PC_1698331967329665262&q=product) rank as the best noise\\-cancelling headphones under $100, delivering hybrid active noise cancellation, long battery life, and comfortable over\\-ear builds without stretching your budget. [0] [1]\n\n### Top Noise\\-Cancelling Headphones Under $100\n\n| Headphone Model | Best For | Key ANC & Battery Specs | Estimated Price |\n| --- | --- | --- | --- |\n| Soundcore Life Q30 by AnkerGo to product viewer dialog for this item. | All\\-around performance & customizable EQ | Hybrid ANC \\(up to 95% low\\-freq block\\), 50 hrs playtime \\(ANC on\\) | Target |\n| JLab JBuds Lux ANCGo to product viewer dialog for this item. | Lightweight comfort & spatial audio | Smart ANC \\(up to 35 dB\\), 70\\+ hrs battery, spatial audio | Best Buy |\n| JBL Tune 780NCGo to product viewer dialog for this item. | Strong bass and multi\\-point pairing | Adaptive ANC, up to 50 hrs playtime \\(ANC on\\), quick charge \\(5 min = 5 hrs\\) | Best Buy |\n| Soundcore Life Q20Go to product viewer dialog for this item. | Tight budget value | Hybrid ANC \\(reduces ambient noise up to 90%\\), 40 hrs playtime | \\~$30 – $60 |\n\n### Detailed Breakdown\n\n- [Soundcore Life Q30 by Anker](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462887977951291,imageDocid:17508826014207272230,gpcid:168455216098522800,headlineOfferDocid:16917759782074610490,catalogid:15027068778094995066,productDocid:18132781609728767484,rds:PC_168455216098522800%7CPROD_PC_168455216098522800&q=product) — $85.99 — 4.6★ \\(2200 reviews\\) — soundcore NA& more\n  - Noise Cancellation: Features multi\\-mode hybrid ANC \\(Transport, Outdoor, and Indoor modes\\) that effectively dampens airplane engines, traffic, and office chatter.\n  - Sound & Battery: Equipped with 40mm silk\\-diaphragm drivers and a companion app with deep EQ customization. Battery lasts up to 50 hours with ANC turned on \\(and up to 80 hours in standard mode\\).\n- [JLab JBuds Lux ANC](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462768183402495,imageDocid:3602113712907389807,gpcid:1698331967329665262,headlineOfferDocid:12185191750580024426,catalogid:2048947465217953597,productDocid:8139787361734834398,rds:PC_1698331967329665262%7CPROD_PC_1698331967329665262&q=product) — $39.99$85 — 4.6★ \\(7500 reviews\\) — Best Buy& more\n  - Noise Cancellation: Offers smart active noise cancellation blocking up to 35 dB of ambient clutter, alongside a \"Be Aware\" transparency mode.\n  - Sound & Battery: Features built\\-in spatial audio support, comfortable cloud\\-foam ear cushions, and an impressive 70\\+ hour total battery footprint.\n- [JBL Tune 780NC](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,mid:576462900042129598,imageDocid:4545642008504167891,gpcid:3190701464784996572,headlineOfferDocid:15324287994433380357,catalogid:14889218957507998288,productDocid:4847594757674650042,rds:PC_3190701464784996572%7CPROD_PC_3190701464784996572&q=product) — $89.95$150 — 4.6★ \\(776 reviews\\) — Best Buy& more [0] [1] [2]\n  - Noise Cancellation: Utilizes adaptive noise\\-cancelling with dedicated commuting and anti\\-wind modes.\n  - Sound & Battery: Delivers signature JBL Pure Bass sound, multi\\-point Bluetooth switching across two devices simultaneously, and up to 50 hours of playback with ANC active. [0] [1] [2]\n\nAre you looking for over\\-ear or in\\-ear \\(earbuds\\) style, and will you mostly use them for travel, the gym, or quiet office work?\n\n\n### References\n\n[0] [JLab JBuds Lux ANC Over\\-Ear Headphones](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,productid:8139787361734834398,catalogid:2048947465217953597,gpcid:1698331967329665262,mid:576462768183402495&q=product) — You can enjoy music like you're actually there with the JBuds Lux ANC Gray. The headphones have spatial audio. With this technology, music sounds like it surrounds you. Want to enjoy music without hearing the people around you? That's possible with the active noise canceling. This technology reduces ambient noise, so you're less bothered by talking people in public transport. The cloud foam comfort ear cushions are made based on the shape of the ear. That way, the headphones are comfortable and you can listen to music or podcasts for a long time. You can adjust the sound to your wishes in the JLab app. You can amplify the bass when you clearly want to hear the beat, for example.\n\n[1] [Soundcore Q30 by Anker](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,productid:8561437252339516764,catalogid:7136944671779279509,gpcid:9164371928389566269&q=product) — Stay focused with the Soundcore Q30 Wireless ANC Noise Cancelling Headphones in Black, designed with hybrid active noise cancellation to reduce distractions. These Soundcore Q30 headphones feature dual noise\\-detecting microphones on each side to block up to 95% of low\\-frequency sound. Choose from three noise cancellation modes to match your environment. Transport mode reduces airplane engine noise, Outdoor mode handles traffic and wind, while Indoor mode helps minimise background conversations. Please note that ANC is not supported when connected via AUX cable. Equipped with 40mm drivers and silk diaphragms, the Soundcore wireless headphones reproduce detailed mids and highs, while pre\\-tuned EQ presets enhance bass for a fuller sound. The Soundcore Q30 ANC headphones provide up to 50 hours of playtime in noise cancelling mode and up to 80 hours in standard mode. A quick 10\\-minute charge delivers up to 10 hours of listening time.\n\n[2] [JBL Tune 780NC Noise Cancelling Wireless Over\\-Ear Headphones](https://www.google.com/search?ibp=oshop&prds=pvt:hg,pvo:29,productid:4847594757674650042,catalogid:14889218957507998288,gpcid:3190701464784996572,mid:576462900042129598&q=product) — Pure bass, noise free. Your music takes center stage with JBL Tune 780NC wireless headphones. JBL Pure Bass Sound and immersive Spatial Sound surround you with crisp, powerful music, while Adaptive Noise Cancelling keeps you free from distractions. The sleek over\\-ear design with subtle metal accents makes a statement in your choice of stylish colors. Up to 76 hours of battery life means you can go a week between charges. And if you do need a top\\-up, five minutes gets you another 5 hours\\-or just plug in the detachable headphone cable to stay in the groove. With 2 mics that accurately pick\\-up your voice, calls sound perfect on both ends. Seamless Bluetooth switching makes it easy to stay connected across devices, while the JBL Headphones app lets you tailor the sound of your music and crystal\\-clear calls with ease. They're lightweight enough to wear all day, and foldable so they slip easily into any bag when the music's over. From morning podcasts to all\\-night playlists, JBL Tune 780NC headphones are built to keep up and stand out.\n"
};

/** engine=google_ai_mode, q="best CRM for a 50 person startup", async=true then read back (Success). Text blocks, nested lists, per-element reference_indexes, one reference. */
export const aiModeQueuedResult: unknown = {
  "search_metadata": {
    "status": "Success"
  },
  "text_blocks": [
    {
      "type": "paragraph",
      "snippet": "At a 50-person startup, you are in the \"Goldilocks zone\" of CRM needs: simple tools (like a shared spreadsheet or lightweight tracker) no longer cut it, but bloated enterprise monoliths (like full-scale Salesforce) will choke your team in heavy configuration and admin costs.",
      "snippet_highlighted_words": [
        "bloated enterprise monoliths"
      ],
      "reference_indexes": [
        0
      ]
    },
    {
      "type": "paragraph",
      "snippet": "The best choice depends heavily on your primary motion (inbound vs. outbound sales, heavy automation, or relationship-driven networking)."
    },
    {
      "type": "heading",
      "snippet": "Top CRM Recommendations for a 50-Person Startup"
    },
    {
      "type": "list",
      "list": [
        {
          "snippet": "HubSpot (Professional Tier) — Best All-in-One for Marketing, Sales, and Scale",
          "list": [
            {
              "snippet": "The Sweet Spot: At 50 people, HubSpot’s Sales and Marketing Hubs (leveraging their embedded AI engine, Breeze) are powerful enough to run a structured go-to-market motion without requiring a dedicated full-time administrator."
            },
            {
              "snippet": "Why it fits: It seamlessly bridges inbound marketing, sales pipelines, and basic customer service. It scales smoothly past 100+ employees if you plan to aggressively grow revenue operations."
            },
            {
              "snippet": "Watch out for: Pricing accelerates quickly as you add contacts and upgrade tiers."
            }
          ]
        },
        {
          "snippet": "Pipedrive — Best for Sales-Led, Pipeline-First Teams",
          "list": [
            {
              "snippet": "The Sweet Spot: If your 50-person company revolves around an active outbound sales team that lives and dies by visual deal stages, Pipedrive is fast, intuitive, and boasts sky-high user adoption."
            },
            {
              "snippet": "Why it fits: It requires almost zero onboarding time, has a robust integration marketplace, and stays transparently priced per user rather than penalizing you for database size."
            },
            {
              "snippet": "Watch out for: It is strictly a sales CRM; if you need heavy native marketing automation or customer support ticketing, you will need separate tools."
            }
          ]
        },
        {
          "snippet": "Attio — Best Modern, Data-Driven CRM for Tech Startups",
          "list": [
            {
              "snippet": "The Sweet Spot: A fast-rising favorite for modern tech and B2B startups. It feels like a cross between a flexible database (like Notion) and a traditional CRM."
            },
            {
              "snippet": "Why it fits: It automatically syncs email and calendar history from Google/Outlook, handles custom objects exceptionally well, and has a clean, lightning-fast UI that doesn't feel like enterprise software from 2008."
            },
            {
              "snippet": "Watch out for: Less out-of-the-box historical legacy features compared to HubSpot, though it handles modern collaborative workflows brilliantly.",
              "reference_indexes": [
                0
              ]
            }
          ],
          "reference_indexes": [
            0
          ]
        },
        {
          "snippet": "Zoho CRM / Bigin — Best Value and Customization Balance",
          "list": [
            {
              "snippet": "The Sweet Spot: Startups looking for enterprise-grade customizability on a lean budget."
            },
            {
              "snippet": "Why it fits: Zoho offers an immense suite of integrated apps (finance, inventory, desk) that scale all the way from a 50-person organization to a 200+ enterprise at a fraction of Salesforce's price.",
              "reference_indexes": [
                0
              ]
            }
          ],
          "reference_indexes": [
            0
          ]
        }
      ]
    },
    {
      "type": "heading",
      "snippet": "Crucial Advice for a 50-Person Team"
    },
    {
      "type": "paragraph",
      "snippet": "No matter which tool you pick, CRM success at this stage is a governance issue, not a software issue.",
      "reference_indexes": [
        0
      ]
    },
    {
      "type": "list",
      "list": [
        {
          "snippet": "Assign one person (a RevOps lead or sales operations owner) to act as the strict gatekeeper for custom properties, required fields, and pipeline stages."
        },
        {
          "snippet": "Without guardrails, a 50-person team will quickly turn any clean CRM UI into an unsearchable data mess.",
          "reference_indexes": [
            0
          ]
        }
      ]
    },
    {
      "type": "paragraph",
      "snippet": "To help narrow down the ideal platform, tell me:"
    },
    {
      "type": "list",
      "list": [
        {
          "snippet": "What is your primary go-to-market motion (Inbound marketing, outbound sales, or partner/relationship networking)?"
        },
        {
          "snippet": "Do you need marketing automation and customer support desks baked in, or just a pure sales pipeline?"
        }
      ]
    }
  ],
  "references": [
    {
      "index": 0,
      "title": "Best startup CRM for 20-50 person teams? We're trying to ...",
      "link": "https://www.reddit.com/r/CRM/comments/1tvlwhb/best_startup_crm_for-TRUNCATED/",
      "snippet": "the \"50 mystery custom properties\" problem is mostly a governance issue, not a tool one. Any CRM bloats if nobody owns the schema. Attio and Pipedrive both fit the...",
      "source": "Reddit",
      "source_icon": "https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.reddit.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL"
    }
  ],
  "reconstructed_markdown": "At a 50\\-person startup, you are in the \"Goldilocks zone\" of CRM needs: simple tools \\(like a shared spreadsheet or lightweight tracker\\) no longer cut it, but bloated enterprise monoliths \\(like full\\-scale Salesforce\\) will choke your team in heavy configuration and admin costs. [0]\n\nThe best choice depends heavily on your primary motion \\(inbound vs. outbound sales, heavy automation, or relationship\\-driven networking\\).\n\n### Top CRM Recommendations for a 50\\-Person Startup\n\n- HubSpot \\(Professional Tier\\) — Best All\\-in\\-One for Marketing, Sales, and Scale\n  - The Sweet Spot: At 50 people, HubSpot’s Sales and Marketing Hubs \\(leveraging their embedded AI engine, Breeze\\) are powerful enough to run a structured go\\-to\\-market motion without requiring a dedicated full\\-time administrator.\n  - Why it fits: It seamlessly bridges inbound marketing, sales pipelines, and basic customer service. It scales smoothly past 100\\+ employees if you plan to aggressively grow revenue operations.\n  - Watch out for: Pricing accelerates quickly as you add contacts and upgrade tiers.\n- Pipedrive — Best for Sales\\-Led, Pipeline\\-First Teams\n  - The Sweet Spot: If your 50\\-person company revolves around an active outbound sales team that lives and dies by visual deal stages, Pipedrive is fast, intuitive, and boasts sky\\-high user adoption.\n  - Why it fits: It requires almost zero onboarding time, has a robust integration marketplace, and stays transparently priced per user rather than penalizing you for database size.\n  - Watch out for: It is strictly a sales CRM; if you need heavy native marketing automation or customer support ticketing, you will need separate tools.\n- Attio — Best Modern, Data\\-Driven CRM for Tech Startups [0]\n  - The Sweet Spot: A fast\\-rising favorite for modern tech and B2B startups. It feels like a cross between a flexible database \\(like Notion\\) and a traditional CRM.\n  - Why it fits: It automatically syncs email and calendar history from Google/Outlook, handles custom objects exceptionally well, and has a clean, lightning\\-fast UI that doesn't feel like enterprise software from 2008.\n  - Watch out for: Less out\\-of\\-the\\-box historical legacy features compared to HubSpot, though it handles modern collaborative workflows brilliantly. [0]\n- Zoho CRM / Bigin — Best Value and Customization Balance [0]\n  - The Sweet Spot: Startups looking for enterprise\\-grade customizability on a lean budget.\n  - Why it fits: Zoho offers an immense suite of integrated apps \\(finance, inventory, desk\\) that scale all the way from a 50\\-person organization to a 200\\+ enterprise at a fraction of Salesforce's price. [0]\n\n### Crucial Advice for a 50\\-Person Team\n\nNo matter which tool you pick, CRM success at this stage is a governance issue, not a software issue. [0]\n\n- Assign one person \\(a RevOps lead or sales operations owner\\) to act as the strict gatekeeper for custom properties, required fields, and pipeline stages.\n- Without guardrails, a 50\\-person team will quickly turn any clean CRM UI into an unsearchable data mess. [0]\n\nTo help narrow down the ideal platform, tell me:\n\n- What is your primary go\\-to\\-market motion \\(Inbound marketing, outbound sales, or partner/relationship networking\\)?\n- Do you need marketing automation and customer support desks baked in, or just a pure sales pipeline?\n\n\n### References\n\n[0] [Best startup CRM for 20\\-50 person teams? We're trying to ...](https://www.google.com/goto?url=CAESlQEB6zswFUCKb2dA-TRUNCATED) — the \"50 mystery custom properties\" problem is mostly a governance issue, not a tool one. Any CRM bloats if nobody owns the schema. Attio and Pipedrive both fit the...\n"
};

/** The async=true submit response of the call above while it was still running (search_metadata.status "Processing"); the id is a placeholder. */
export const aiModeSubmitProcessing: unknown = {
  "search_metadata": {
    "id": "recorded-search-id",
    "status": "Processing"
  }
};

/** engine=google, q="how to choose a CRM for a small business", live. Abridged: organic_results, related_questions, related_searches, inline_videos and discussions_and_forums cut to 2 entries. ai_overview carries ONLY page_token and serpapi_link: the on-demand case. Read without following the token this is a null payload that looks like "no AI Overview". */
export const aioDeferred: unknown = {
  "search_metadata": {
    "status": "Success"
  },
  "inline_videos": [
    {
      "position": 1,
      "title": "How to Pick the Right CRM for Your Business",
      "link": "https://www.youtube.com/watch?v=CCcFIr53HpQ&t=174",
      "thumbnail": "https://serpapi.com/REDACTED-image",
      "channel": "SOLVD cloud",
      "duration": "52s",
      "platform": "YouTube",
      "date": "Apr 8, 2026",
      "snippet": "For startups (1-10 employees), HubSpot Free or Pipedrive are recommended due to their low cost and ease of adoption.",
      "short_clip": "https://encrypted-vtbn0.gstatic.com/video?q=tbn:ANd9GcTCwhtkoCQILk9W-TRUNCATED"
    },
    {
      "position": 2,
      "title": "How to Choose the Right CRM for Your Business [CRM Series]",
      "link": "https://www.youtube.com/watch?v=bnBHAUEKo54",
      "thumbnail": "https://serpapi.com/REDACTED-image",
      "channel": "SelectHub",
      "duration": "6:44",
      "platform": "YouTube",
      "date": "2 weeks ago",
      "snippet": "Choose the right CRM by defining your business model, mapping operating complexity, identifying jobs to be done, and aligning stakeholders.",
      "short_clip": "https://encrypted-vtbn0.gstatic.com/video?q=tbn:ANd9GcSCJHwp67P-jALL-TRUNCATED"
    }
  ],
  "related_questions": [
    {
      "question": "What are the different types of CRM software?",
      "type": "featured_snippet",
      "next_page_token": "eyJvbnMiOiIxMDA0MSIs-TRUNCATED/IiwibGsiOiJHaFYwZVhC-TRUNCATED==",
      "serpapi_link": "https://serpapi.com/search.json?device=desktop&engine=google_related_questions&google_domain=google.com&next_page_token=eyJvbnMiOiIxMDA0MSIs-TRUNCATED%2FIiwibGsiOiJHaFYwZV-TRUNCATED%3D%3D"
    },
    {
      "question": "Is Zoho CRM still free?",
      "type": "featured_snippet",
      "next_page_token": "eyJvbnMiOiIxMDA0MSIs-TRUNCATED==",
      "serpapi_link": "https://serpapi.com/search.json?device=desktop&engine=google_related_questions&google_domain=google.com&next_page_token=eyJvbnMiOiIxMDA0MSIs-TRUNCATED%3D%3D"
    }
  ],
  "ai_overview": {
    "page_token": "SDfXEXiczVbddqo4FH6B-TRUNCATED",
    "serpapi_link": "https://serpapi.com/search.json?engine=google_ai_overview&page_token=SDfXEXiczVbddqo4FH6B-TRUNCATED"
  },
  "organic_results": [
    {
      "position": 1,
      "title": "Best CRM: Everything You Need To Consider",
      "link": "/goto?url=CAESZgHrOzAVDNUR5tWS-TRUNCATED",
      "redirect_link": "https://www.google.com/url?sa=t&source=web&rct=j&opi=89978449&url=CAESZgHrOzAVo_NJi4fE-TRUNCATED&ved=2ahUKEwj6maHTi-GXAxW-TRUNCATED&uoh=1",
      "displayed_link": "https://www.salesforce.com › crm › best-crm",
      "favicon": "https://serpapi.com/REDACTED-image",
      "snippet": "Small business CRMs focus on ease of use and essential features like contact management and basic AI agents and automation. Enterprise CRMs",
      "snippet_highlighted_words": [
        "Small business CRMs focus on ease of use and essential features"
      ],
      "about_this_result": {
        "source": {
          "description": "Small business CRMs focus on ease of use and essential features like contact management and basic AI agents and automation. Enterprise CRMs",
          "source_info_link": "/goto?url=CAESZgHrOzAVDNUR5tWS-TRUNCATED",
          "icon": "https://serpapi.com/REDACTED-image"
        },
        "languages": [
          "en"
        ],
        "regions": [
          "US"
        ]
      },
      "about_page_link": "https://www.google.com/search/about-this-result?origin=www.google.com&req=CpgBL2dvdG8_dXJsPUNB-TRUNCATED",
      "about_page_serpapi_link": "https://serpapi.com/search.json?engine=google_about_this_result&google_domain=google.com&req_token=CpgBL2dvdG8_dXJsPUNB-TRUNCATED",
      "source": "Salesforce"
    },
    {
      "position": 2,
      "title": "The 11 Best CRMs for Small Business in 2026",
      "link": "/goto?url=CAEScAHrOzAVu_cKR6NJ-TRUNCATED",
      "redirect_link": "https://www.google.com/url?sa=t&source=web&rct=j&opi=89978449&url=CAEScAHrOzAVtFigO96_-TRUNCATED&ved=2ahUKEwj6maHTi-GXAxW-TRUNCATED&uoh=1",
      "displayed_link": "https://zapier.com › App picks › Best apps",
      "favicon": "https://serpapi.com/REDACTED-image",
      "date": "Jul 3, 2026",
      "snippet": "Best CRM for scaling your small business. Zoho CRM (Web, iOS, Android). Zoho CRM, our pick for the best CRM for scaling your small business.",
      "snippet_highlighted_words": [
        "Zoho CRM"
      ],
      "about_this_result": {
        "source": {
          "description": "Best CRM for scaling your small business. Zoho CRM (Web, iOS, Android). Zoho CRM, our pick for the best CRM for scaling your small business.",
          "source_info_link": "/goto?url=CAEScAHrOzAVu_cKR6NJ-TRUNCATED",
          "icon": "https://serpapi.com/REDACTED-image"
        },
        "languages": [
          "en"
        ],
        "regions": [
          "US"
        ]
      },
      "about_page_link": "https://www.google.com/search/about-this-result?origin=www.google.com&req=CqUBL2dvdG8_dXJsPUNB-TRUNCATED",
      "about_page_serpapi_link": "https://serpapi.com/search.json?engine=google_about_this_result&google_domain=google.com&req_token=CqUBL2dvdG8_dXJsPUNB-TRUNCATED",
      "source": "Zapier",
      "read_more_link": "https://www.google.com/goto?url=CAESxAEB6zswFWQfPIxj-TRUNCATED"
    }
  ],
  "related_searches": [
    {
      "block_position": 1,
      "query": "How to choose a crm for a small business quiz",
      "link": "https://www.google.com/search?sca_esv=c55da69dae0261d8&gl=us&hl=en&sxsrf=AKL5yDhcwP38EecM5o9YLZlYHE7-v4_9RA:1793340952046&q=How+to+choose+a+crm+for+a+small+business+quiz&sa=X&ved=2ahUKEwj6maHTi-GXAxW-TRUNCATED",
      "serpapi_link": "https://serpapi.com/search.json?device=desktop&engine=google&gl=us&google_domain=google.com&hl=en&q=How+to+choose+a+crm+for+a+small+business+quiz"
    },
    {
      "block_position": 1,
      "query": "Zoho CRM",
      "link": "https://www.google.com/search?sca_esv=c55da69dae0261d8&gl=us&hl=en&sxsrf=AKL5yDhcwP38EecM5o9YLZlYHE7-v4_9RA:1793340952046&q=Zoho+CRM&sa=X&ved=2ahUKEwj6maHTi-GXAxW-TRUNCATED",
      "serpapi_link": "https://serpapi.com/search.json?device=desktop&engine=google&gl=us&google_domain=google.com&hl=en&q=Zoho+CRM"
    }
  ],
  "discussions_and_forums": [
    {
      "title": "What should I look for when choosing a CRM for a small to mid-sized team?",
      "link": "https://www.google.com/goto?url=CAESmgEB6zswFarjTQwh-TRUNCATED",
      "date": "1 year ago",
      "extensions": [
        "r/CRM",
        "40+ comments"
      ],
      "source": "Reddit",
      "answers": [
        {
          "link": "https://www.google.com/goto?url=CAESogEB6zswFcoL09B3-TRUNCATED",
          "extensions": [
            "Top answer",
            "12 votes",
            "10 months ago"
          ]
        },
        {
          "link": "https://www.google.com/goto?url=CAESogEB6zswFYKOihrd-TRUNCATED",
          "extensions": [
            "7 votes",
            "a year ago"
          ]
        },
        {
          "link": "https://www.google.com/goto?url=CAESogEB6zswFViwNmnU-TRUNCATED",
          "extensions": [
            "4 votes",
            "a year ago"
          ]
        }
      ]
    },
    {
      "title": "How do you choose the right CRM for a small business?",
      "link": "https://www.google.com/goto?url=CAESnQEB6zswFRQ0Esub-TRUNCATED",
      "date": "11 months ago",
      "extensions": [
        "r/CRMSoftware",
        "70+ comments"
      ],
      "source": "Reddit",
      "answers": [
        {
          "link": "https://www.google.com/goto?url=CAESpQEB6zswFQN4ef7N-TRUNCATED",
          "extensions": [
            "Top answer",
            "3 votes",
            "11 months ago"
          ]
        },
        {
          "link": "https://www.google.com/goto?url=CAESpQEB6zswFS5vlLZw-TRUNCATED",
          "extensions": [
            "2 votes",
            "11 months ago"
          ]
        },
        {
          "link": "https://www.google.com/goto?url=CAESpQEB6zswFTBH39rJ-TRUNCATED",
          "extensions": [
            "2 votes",
            "11 months ago"
          ]
        }
      ]
    }
  ]
};

/** engine=google_ai_overview, page_token from the deferred response above (used immediately). The deferred overview: text_blocks and references. */
export const aioFollowUp: unknown = {
  "search_metadata": {
    "status": "Success"
  },
  "ai_overview": {
    "text_blocks": [
      {
        "type": "paragraph",
        "snippet": "Choosing a Customer Relationship Management (CRM) system for a small business means finding a balance between ease of use, cost, and the features your team will actually adopt.",
        "snippet_highlighted_words": [
          "finding a balance between ease of use, cost, and the features your team will actually adopt"
        ],
        "reference_indexes": [
          0
        ]
      },
      {
        "type": "heading",
        "snippet": "Step 1: Identify Your Core Business Model"
      },
      {
        "type": "list",
        "list": [
          {
            "snippet": "Sales-driven or pipeline-focused: If your team manages active deals and needs a visual, drag-and-drop board to track where leads stand, look at tools like Pipedrive ."
          },
          {
            "snippet": "Inbound marketing and content heavy: If you rely heavily on email newsletters, landing pages, and lead-capture forms, platforms like HubSpot fit well.",
            "reference_indexes": [
              1,
              2
            ]
          },
          {
            "snippet": "Service-based or custom operations: If you need deep customization on a budget, Zoho CRM offers high flexibility.",
            "reference_indexes": [
              2
            ]
          },
          {
            "snippet": "Project and client management together: If you run an agency or consultancy where project tracking needs to happen right when a deal closes, Insightly integrates both."
          }
        ]
      },
      {
        "type": "heading",
        "snippet": "Step 2: Key Features to Evaluate"
      },
      {
        "type": "list",
        "list": [
          {
            "snippet": "Ease of Use: If it takes weeks of training to log a contact, your team won’t use it. Prioritize a clean interface and quick setup.",
            "reference_indexes": [
              3,
              4
            ]
          },
          {
            "snippet": "Automations: Look for built-in tools that eliminate manual busywork, such as automatic follow-up emails, task reminders, and data syncing.",
            "reference_indexes": [
              5
            ]
          },
          {
            "snippet": "Integrations: Ensure the CRM connects smoothly with your existing email (Gmail/Outlook), calendar, accounting, or marketing apps.",
            "reference_indexes": [
              4,
              5
            ]
          },
          {
            "snippet": "Data Import: Check how easily you can pull in existing customer spreadsheets or contacts from your current workflow.",
            "reference_indexes": [
              3
            ]
          },
          {
            "snippet": "Scalability: Avoid systems so basic you will outgrow them in a year, or enterprise monsters (like full-scale ) that require expensive consultants to configure.",
            "snippet_links": [
              {
                "link": "https://www.salesforce.com/small-business/software/"
              }
            ],
            "reference_indexes": [
              4
            ]
          }
        ]
      },
      {
        "type": "heading",
        "snippet": "Step 3: Test Before You Buy"
      },
      {
        "type": "list",
        "list": [
          {
            "snippet": "Map your actual workflow: Don’t shop by feature checklists. Test how the software handles your specific daily tasks (e.g., adding a lead, moving a deal, or pulling a sales report)."
          },
          {
            "snippet": "Run a free trial: Put your real team (sales, marketing, or support) into a free trial or demo to score them on speed, clarity, and overall user experience."
          },
          {
            "snippet": "Calculate Total Cost of Ownership: Look past the introductory monthly per-user price. Check if mandatory onboarding fees, higher-tier upgrades for basic automation, or phone support add unexpected costs .",
            "reference_indexes": [
              6,
              7,
              8
            ]
          }
        ]
      },
      {
        "type": "paragraph",
        "snippet": "Here is a guide explaining how to evaluate and pick the right CRM system for your business needs:"
      },
      {
        "type": "paragraph",
        "snippet": "To help narrow down the best options, tell me:"
      },
      {
        "type": "list",
        "list": [
          {
            "snippet": "What industry is your small business in?"
          },
          {
            "snippet": "How many people will be using the CRM?"
          },
          {
            "snippet": "What is your primary goal (e.g., tracking sales deals, managing customer service, or email marketing)?"
          }
        ]
      }
    ],
    "references": [
      {
        "index": 0,
        "title": "Small Business CRM Buyers Guide | Nutshell",
        "link": "https://www.nutshell.com/blog/best-crms-for-small-businesses",
        "snippet": "Quick answer: What is the best CRM for a small business? The best CRM for a small business is affordable, easy to adopt, and matched to your actual sales process r...",
        "source": "www.nutshell.com",
        "source_icon": "https://encrypted-tbn0.gstatic.com/faviconV2?url=https://www.nutshell.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
        "thumbnail": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTSziIA73d3qB91-TRUNCATED"
      },
      {
        "index": 1,
        "title": "My TOP 5 CRM Software | Free vs Paid CRMs for Small Business",
        "link": "https://www.youtube.com/watch?v=GCMdLB82FXg&vl=en&t=172",
        "snippet": "My TOP 5 CRM Software | Free vs Paid CRMs for Small Business i would recommend Bingan for small service-based businesses that are looking to grow long-term. and fo",
        "source": "YouTube",
        "source_icon": "https://serpapi.com/REDACTED-image",
        "thumbnail": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQpCqVXK92GSliq-TRUNCATED"
      },
      {
        "index": 2,
        "title": "How to Choose the Right CRM Platform for Small and Medium ...",
        "link": "https://www.linkedin.com/pulse/how-choose-right-crm-TRUNCATED",
        "snippet": "Salesforce: Powerful and customizable, but better suited for businesses with larger teams and budgets. Salesforce also requires some technical knowledge which migh...",
        "source": "LinkedIn",
        "source_icon": "https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.linkedin.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
        "thumbnail": "https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcTF4SPelAvUPvf7-TRUNCATED"
      },
      {
        "index": 3,
        "title": "How to choose the best CRM system for small business",
        "link": "https://www.solutions.kompass.com/blog/how-to-choose-the-be-TRUNCATED/",
        "snippet": "What should you pay attention to when choosing CRM for a small company? All-in-one functionality: CRM should be able to combine operations and integrate services t...",
        "source": "www.solutions.kompass.com",
        "source_icon": "https://encrypted-tbn1.gstatic.com/faviconV2?url=https://www.solutions.kompass.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
        "thumbnail": "https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcSPaK8QRO2PA8N1-TRUNCATED"
      },
      {
        "index": 4,
        "title": "The 11 Best CRMs for Small Business in 2026 | Zapier",
        "link": "https://zapier.com/blog/best-crms-for-small-business/",
        "snippet": "The 11 best CRMs for small business in 2026 By Miguel Rebelo · July 3, 2026 We independently review every app we recommend in our best apps lists. When you click s...",
        "source": "Zapier",
        "source_icon": "https://encrypted-tbn1.gstatic.com/faviconV2?url=https://zapier.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
        "thumbnail": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTYBJ-g4uH5BS8t-TRUNCATED"
      },
      {
        "index": 5,
        "title": "How to choose a CRM for your small business",
        "link": "https://www.youtube.com/watch?v=eWh_PBsE0gc",
        "snippet": "Watch the video for a quick guide to choosing the right small business CRM. For more guidance on assessing a CRM for small businesses, ...",
        "source": "YouTube",
        "source_icon": "https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.youtube.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
        "thumbnail": "https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcQXU1TUGVmQ_pPl-TRUNCATED"
      },
      {
        "index": 6,
        "title": "What CRM Software Is The Best For Beginners?",
        "link": "https://www.youtube.com/watch?v=0p92peQETVk&t=59",
        "snippet": "What CRM Software Is The Best For Beginners? market has exploded there are literally hundreds of options prices are changing constantly features get added and remo",
        "source": "YouTube",
        "source_icon": "https://serpapi.com/REDACTED-image",
        "thumbnail": "https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcQTMwLlGMEEksoR-TRUNCATED"
      },
      {
        "index": 7,
        "title": "How to Choose the Right CRM for Your Business [CRM Series]",
        "link": "https://www.youtube.com/watch?v=bnBHAUEKo54",
        "snippet": "7 steps for how to run a proper CRM evaluation · How to map GTM motion, operating complexity, and stakeholder needs · 15 functional requirements ...",
        "source": "YouTube",
        "source_icon": "https://serpapi.com/REDACTED-image",
        "thumbnail": "https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcQIKqD19WwgSEHd-TRUNCATED"
      },
      {
        "index": 8,
        "title": "How to Choose a CRM: A Complete Guide for 2026 | Creatio",
        "link": "https://www.creatio.com/glossary/how-to-choose-crm",
        "snippet": "How to Choose the Best CRM Software: A Step-by-Step Guide * Creatio offers a composable pricing model that enables organizations to pay only for the products they ...",
        "source": "Creatio",
        "source_icon": "https://encrypted-tbn2.gstatic.com/faviconV2?url=https://www.creatio.com&client=AIM&size=128&type=FAVICON&fallback_opts=TYPE,SIZE,URL",
        "thumbnail": "https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcR39IgKqJARaMrP-TRUNCATED"
      }
    ]
  }
};

/** engine=google, q="facebook login", live. Abridged to 2 organic results. No ai_overview key at all: Google showed no AI Overview. */
export const aioAbsent: unknown = {
  "search_metadata": {
    "status": "Success"
  },
  "organic_results": [
    {
      "position": 1,
      "title": "Log into Facebook",
      "link": "https://www.facebook.com/login/",
      "redirect_link": "https://www.google.com/url?sa=t&source=web&rct=j&opi=89978449&url=CAESWgHrOzAV9--nK-h7-TRUNCATED&ved=2ahUKEwjM7q_bi-GXAxW-TRUNCATED&uoh=1",
      "displayed_link": "https://www.facebook.com › login",
      "favicon": "https://serpapi.com/REDACTED-image",
      "snippet": "Get Facebook for Android and browse faster. English (US). Facebook from Meta. Mobile ... Log in. Forgot password? Create new account · About · Help. More.",
      "snippet_highlighted_words": [
        "Facebook",
        "Facebook",
        "Log in"
      ],
      "sitelinks": {
        "expanded": [
          {
            "title": "Log in",
            "link": "https://limited.facebook.com/login/",
            "snippet": "facebook. HIDESHOW. Log in. Forgot password? or. Create ..."
          },
          {
            "title": "Login and Password",
            "link": "https://www.google.com/goto?url=CAESXwHrOzAVoq-B16nu-TRUNCATED",
            "snippet": "Find out what to do if you're having trouble logging in, or learn how ..."
          },
          {
            "title": "Forgot password?",
            "link": "https://www.google.com/goto?url=CAESwQEB6zswFSo20W9s-TRUNCATED",
            "snippet": "Facebook. facebook. A... E... HIDESHOW. Log In. Forgot ..."
          },
          {
            "title": "Find your account",
            "link": "https://www.google.com/goto?url=CAESYwHrOzAVcaNLJ-8_-TRUNCATED",
            "snippet": "Facebook. Find your account. Enter your mobile number."
          },
          {
            "title": "Facebook Login",
            "link": "https://www.google.com/goto?url=CAEScwHrOzAVi1yovzjW-TRUNCATED",
            "snippet": "Facebook Login enables people to have private & secure ..."
          }
        ]
      },
      "about_this_result": {
        "source": {
          "description": "Get Facebook for Android and browse faster. English (US). Facebook from Meta. Mobile ... Log in. Forgot password? Create new account · About · Help. More.",
          "source_info_link": "https://www.facebook.com/login/",
          "icon": "https://serpapi.com/REDACTED-image"
        },
        "languages": [
          "en"
        ],
        "regions": [
          "US"
        ]
      },
      "about_page_link": "https://www.google.com/search/about-this-result?origin=www.google.com&req=CogBL2dvdG8_dXJsPUNB-TRUNCATED",
      "about_page_serpapi_link": "https://serpapi.com/search.json?engine=google_about_this_result&google_domain=google.com&req_token=CogBL2dvdG8_dXJsPUNB-TRUNCATED",
      "source": "Facebook"
    },
    {
      "position": 2,
      "title": "Log into Facebook",
      "link": "/goto?url=CAESYQHrOzAVabQAuI_--TRUNCATED",
      "redirect_link": "https://www.google.com/url?sa=t&source=web&rct=j&opi=89978449&url=CAESYQHrOzAVFTokvfCb-TRUNCATED&ved=2ahUKEwjM7q_bi-GXAxW-TRUNCATED&uoh=1",
      "displayed_link": "https://secure.facebook.com › login",
      "favicon": "https://serpapi.com/REDACTED-image",
      "snippet": "Log into Facebook to start sharing and connecting with your friends, family, and people you know.",
      "snippet_highlighted_words": [
        "Log into Facebook"
      ],
      "about_this_result": {
        "source": {
          "description": "Log into Facebook to start sharing and connecting with your friends, family, and people you know.",
          "source_info_link": "/goto?url=CAESYQHrOzAVabQAuI_--TRUNCATED",
          "icon": "https://serpapi.com/REDACTED-image"
        },
        "languages": [
          "en"
        ],
        "regions": [
          "US"
        ]
      },
      "about_page_link": "https://www.google.com/search/about-this-result?origin=www.google.com&req=CpEBL2dvdG8_dXJsPUNB-TRUNCATED",
      "about_page_serpapi_link": "https://serpapi.com/search.json?engine=google_about_this_result&google_domain=google.com&req_token=CpEBL2dvdG8_dXJsPUNB-TRUNCATED",
      "source": "Facebook"
    }
  ],
  "related_searches": [
    {
      "block_position": 1,
      "query": "Old Facebook login",
      "link": "https://www.google.com/search?sca_esv=c55da69dae0261d8&gl=us&hl=en&sxsrf=AKL5yDh5D4A_IBYhPiYvWrrGeG8p1YpsOQ:1793340969062&q=Old+Facebook+login&sa=X&ved=2ahUKEwjM7q_bi-GXAxW-TRUNCATED",
      "serpapi_link": "https://serpapi.com/search.json?device=desktop&engine=google&gl=us&google_domain=google.com&hl=en&q=Old+Facebook+login"
    },
    {
      "block_position": 1,
      "query": "Www Facebook com login mobile",
      "link": "https://www.google.com/search?sca_esv=c55da69dae0261d8&gl=us&hl=en&sxsrf=AKL5yDh5D4A_IBYhPiYvWrrGeG8p1YpsOQ:1793340969062&q=Www+Facebook+com+login+mobile&sa=X&ved=2ahUKEwjM7q_bi-GXAxW-TRUNCATED",
      "serpapi_link": "https://serpapi.com/search.json?device=desktop&engine=google&gl=us&google_domain=google.com&hl=en&q=Www+Facebook+com+login+mobile"
    }
  ]
};

/** Hand-built from the documented error shape, NOT recorded: an HTTP 200 whose body is an error string. */
export const errorBody: unknown = { search_metadata: { status: "Error" }, error: "Google hasn't returned any results for this query." };

/** Hand-built, NOT recorded: structurally wrong (text_blocks is not an array). */
export const malformedBody: unknown = { search_metadata: { status: "Success" }, text_blocks: "not-an-array", references: 7 };
