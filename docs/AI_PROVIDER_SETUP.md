# Configure a Veyra LLM provider

Veyra can use any provider that implements an OpenAI Chat Completions-compatible JSON API, or a custom HTTP(S) JSON API described by a request template. It is no longer tied to OpenAI/ChatGPT. The browser talks only to Veyra; provider keys remain on the server. A custom endpoint must accept a configurable API-key header (plus optional static headers) and return non-streaming JSON; OAuth-only, request-signing, SDK-only, or streaming-only APIs need a provider-specific adapter.

## Create a provider API key

Use the provider's official console, create a secret key, and copy it before leaving the page. The provider may show a key only once. Keep it private; never put it in the browser app, a source file, a GitHub repository, an issue, or a log.

| Provider | Create a key (official page) | Basic steps | OpenAI-compatible base URL |
| --- | --- | --- | --- |
| [OpenAI](https://platform.openai.com/api-keys) | [API keys](https://platform.openai.com/api-keys) | Sign in, select a project, open its API Keys page, choose **Create new secret key**, and copy it when displayed. | `https://api.openai.com/v1` · [Chat Completions reference](https://platform.openai.com/docs/api-reference/chat/create) |
| [Anthropic](https://platform.claude.com/settings/keys) | [Claude Console API keys](https://platform.claude.com/settings/keys) | Sign in to the Claude Console, open **Settings → API keys**, create a key, and copy it. Anthropic recommends service-account keys for production. Its OpenAI-compatibility layer is chiefly for testing/comparison, not recommended as a long-term production path; use the native Messages template below for production. | OpenAI-compatibility base: `https://api.anthropic.com/v1/` · [compatibility notes](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) · native endpoint: `https://api.anthropic.com/v1/messages` |
| [Google Gemini](https://aistudio.google.com/apikey) | [Google AI Studio API keys](https://aistudio.google.com/apikey) | Sign in, choose/import a Google Cloud project if prompted, choose **Create API key**, and copy it. | `https://generativelanguage.googleapis.com/v1beta/openai/` · [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |
| [OpenRouter](https://openrouter.ai/keys) | [OpenRouter keys](https://openrouter.ai/keys) | Sign in, create a key, optionally name it and set a credit limit, then copy and store it securely. | `https://openrouter.ai/api/v1` · [API overview](https://openrouter.ai/docs/api_reference/overview) |
| [Groq](https://console.groq.com/keys) | [Groq API keys](https://console.groq.com/keys) | Sign in, open API Keys, choose **Create API Key**, and copy the generated secret. | `https://api.groq.com/openai/v1` · [OpenAI compatibility](https://console.groq.com/docs/openai) |
| [Mistral AI](https://console.mistral.ai/api-keys) | [Mistral API keys](https://console.mistral.ai/api-keys) | Sign in to Studio, open API Keys, choose **Create new key**, name it and set access/expiry, then copy it once. | `https://api.mistral.ai/v1` · [Chat endpoint](https://docs.mistral.ai/api/endpoint/chat) |
| [xAI](https://console.x.ai/team/default/api-keys) | [xAI API keys](https://console.x.ai/team/default/api-keys) | Sign in to the xAI Console, open API Keys, and create a key. xAI's quickstart states API credits are needed to start using the API. | `https://api.x.ai/v1` · [Chat Completions reference](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions) (currently marked legacy by xAI) |
| [Together AI](https://api.together.ai/settings/projects/~current/api-keys) | [Together project API keys](https://api.together.ai/settings/projects/~current/api-keys) | Sign in, select a project, choose **Create API Key**, optionally set expiry, then copy and store the key. | `https://api.together.ai/v1` · [OpenAI compatibility](https://docs.together.ai/docs/inference/openai-compatibility) |
| [DeepSeek](https://platform.deepseek.com/api_keys) | [DeepSeek API keys](https://platform.deepseek.com/api_keys) | Sign in to the DeepSeek Platform, open API Keys, create a key, and copy it for server-side storage. | `https://api.deepseek.com` · [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/) |
| [Azure OpenAI](https://portal.azure.com/?microsoft_azure_marketplace_ItemHideKey=microsoft_openai_tip/Microsoft.CognitiveServicesOpenAI) | [Azure OpenAI in the Azure portal](https://portal.azure.com/?microsoft_azure_marketplace_ItemHideKey=microsoft_openai_tip/Microsoft.CognitiveServicesOpenAI) | Requires an Azure subscription and resource-creation/deployment permission. Create/select a resource, deploy a chat model, then copy Key 1 or Key 2 from **Keys and Endpoint**. Use the deployment name as the model value. | `https://<resource-name>.openai.azure.com/openai/v1` · [Azure v1 API reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat?view=rest-microsoft-foundry-v1) |

## Simplest setup: Groq

For Groq, you only need one Veyra environment variable:

```text
GROQ_API_KEY=<your Groq API key>
```

Create the key in the [Groq Console](https://console.groq.com/keys), then add that variable to the **Veyra server** service's Environment page in Render and save/deploy. Veyra recognizes Groq from the variable name, uses Groq's API endpoint, and calls its [active-model API](https://console.groq.com/docs/models) to choose an available chat model. It prefers active GPT-OSS models, then other known Groq chat models; it filters out audio, embedding, guard, and speech models. You do not need to set `AI_PROVIDER`, a base URL, or a model name. The first answer may take a few seconds longer while Veyra discovers and caches the model. If the list request is unavailable, it falls back to Groq's documented `openai/gpt-oss-120b` model ID.

Provider dashboards change occasionally. Follow each linked provider's current instructions if the labels or steps differ. The exact base URL and API behavior for a selected model are also documented by its provider. Some providers accept only a subset of OpenAI options; Veyra uses `max_completion_tokens` for OpenAI and Groq and `max_tokens` for other providers, and disables the OpenAI-only JSON Schema response-format extension for non-OpenAI providers. Override these defaults only when that endpoint's documentation says to.

## Set the key and endpoint on Render

In the **Veyra server** service in the [Render Dashboard](https://dashboard.render.com/), open **Environment** and add the variables below, then save and deploy. Do not add secret values to `render.yaml`, `.env` files committed to Git, or the browser repository.

### OpenAI-compatible providers

Set these server-side variables; substitute your provider's endpoint and its exact model ID:

```text
AI_PROVIDER_NAME=OpenRouter
AI_API_KEY=<secret key from the provider>
AI_API_BASE_URL=https://openrouter.ai/api/v1
AI_ANSWER_MODEL=<model id supported by that provider>
```

The default request path is `/chat/completions`, the default authentication is `Authorization: Bearer <key>`, and the default response path is `choices.0.message.content`. Set `AI_API_PATH` only if the provider documents a different chat-completions path. `AI_API_URL` can instead hold a complete request URL (including a provider-required query string); when it is set, it takes precedence over the base URL and path. Keep secrets out of URLs whenever the provider supports header-based authentication.

Optional compatibility settings:

| Variable | Purpose | Default |
| --- | --- | --- |
| `AI_PROVIDER` | Provider identifier; set `openai` to select OpenAI defaults, or a provider label for custom integrations. | Inferred as `openai` for legacy `OPENAI_API_KEY`; otherwise `custom` |
| `AI_PROVIDER_NAME` | Safe display name shown in the operations console. | `AI_PROVIDER` |
| `AI_API_KEY_HEADER` | Header used for the key, e.g. `api-key`, `x-api-key`, or `x-goog-api-key`. | `Authorization` |
| `AI_API_KEY_PREFIX` | Text prepended to the key. Set to an empty value when a provider expects the bare key. | `Bearer ` for `Authorization`; empty for other header names |
| `AI_API_HEADERS_JSON` | Additional headers as a JSON object of string values (for example, an API-version header). | `{}` |
| `AI_API_TOKEN_FIELD` | Completion limit field supported by the endpoint. | `max_completion_tokens` for OpenAI/Groq; `max_tokens` for other providers |
| `AI_API_STRUCTURED_OUTPUT` | Include the OpenAI JSON Schema `response_format` extension. | `true` for OpenAI; `false` for other providers; set `true` only if supported |
| `AI_API_OPTIONS_JSON` | Additional JSON request properties for compatible endpoints (for example, `{"temperature":0.2}`). | `{}` |
| `AI_API_RESPONSE_PATH` | Dot-separated path to the model's JSON text in the response. Array indices are supported. | `choices.0.message.content` |
| `AI_API_REQUEST_TEMPLATE_JSON` | Full custom request-body template for non-OpenAI API protocols. | unset |

If you previously configured `OPENAI_API_KEY` (and optionally `OPENAI_API_BASE`), that legacy setup still works. For a new OpenAI key stored in `AI_API_KEY`, set `AI_PROVIDER=openai` to select OpenAI defaults; for another provider, set `AI_API_KEY`, `AI_API_BASE_URL` (or full `AI_API_URL`), and `AI_ANSWER_MODEL` together.

### Azure OpenAI (v1 endpoint)

Azure's v1 Chat Completions endpoint uses the deployment name as `model` and authenticates with the bare `api-key` header (not `Authorization: Bearer`). Set:

```text
AI_PROVIDER_NAME=Azure OpenAI
AI_API_KEY=<key from the Azure resource's Keys and Endpoint page>
AI_API_KEY_HEADER=api-key
AI_API_KEY_PREFIX=
AI_API_BASE_URL=https://<resource-name>.openai.azure.com/openai/v1
AI_ANSWER_MODEL=<your deployed model's deployment name>
```

Veyra appends `/chat/completions`. The Azure v1 endpoint does not need a dated `api-version` query parameter; if you use an older dated deployment endpoint instead, put its complete URL and query string in `AI_API_URL`.

## Use a native custom API protocol

For a provider that is not OpenAI Chat Completions-compatible, set a complete endpoint, its required key/header settings, a JSON request template, and a response path. Template placeholders are replaced with typed request data: `{{model}}`, `{{system}}`, `{{user}}`, `{{messages}}`, `{{max_tokens}}` (integer 4000), `{{response_schema}}` (JSON Schema object), and `{{response_format}}` (the OpenAI structured-output object when enabled). The completed HTTP response path must contain JSON text or an object with an `answer` field; the decoded result must contain `answer` (string), `sourceIds` (array), and `keyPoints` (array). Citations must reference source IDs provided by Veyra; Veyra continues to check the model answer against retrieved evidence.

### Example: Anthropic Messages API

```text
AI_PROVIDER_NAME=Anthropic
AI_API_URL=https://api.anthropic.com/v1/messages
AI_API_KEY=<Anthropic key>
AI_API_KEY_HEADER=x-api-key
AI_API_KEY_PREFIX=
AI_API_HEADERS_JSON={"anthropic-version":"2023-06-01"}
AI_ANSWER_MODEL=<Anthropic model id>
AI_API_STRUCTURED_OUTPUT=false
AI_API_RESPONSE_PATH=content.0.text
```

Set `AI_API_REQUEST_TEMPLATE_JSON` to this JSON (as one line in Render if preferred):

```json
{"model":"{{model}}","system":"{{system}}","max_tokens":"{{max_tokens}}","messages":[{"role":"user","content":"{{user}}"}]}
```

### Example: Google Gemini `generateContent` API

```text
AI_PROVIDER_NAME=Google Gemini
AI_API_URL=https://generativelanguage.googleapis.com/v1beta/models/<MODEL_ID>:generateContent
AI_API_KEY=<Gemini API key>
AI_API_KEY_HEADER=x-goog-api-key
AI_API_KEY_PREFIX=
AI_ANSWER_MODEL=<same Gemini model id>
AI_API_STRUCTURED_OUTPUT=false
AI_API_RESPONSE_PATH=candidates.0.content.parts.0.text
```

Set this request template:

```json
{"systemInstruction":{"parts":[{"text":"{{system}}"}]},"contents":[{"role":"user","parts":[{"text":"{{user}}"}]}],"generationConfig":{"maxOutputTokens":"{{max_tokens}}","responseMimeType":"application/json"}}
```

## Verify configuration safely

The operations console's **AI answer readiness** panel reports whether a provider, model, endpoint, and key are configured and displays the provider/model names. It never returns the key. You can also inspect `GET /api/answer/status`; neither the API key nor custom header values are included in that response. Make one normal `/api/search/answer` request to verify the endpoint, model access, JSON response shape, and citations. A failed or ungrounded synthesis remains an abstention by default.
