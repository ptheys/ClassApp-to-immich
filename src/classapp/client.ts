import axios, { type AxiosInstance } from "axios";
import { loadSession } from "./session.js";
import type { StudentProfile, ClassAppMessageSummary, ClassAppAttachment } from "../types.js";

const CLASSAPP_GRAPHQL_URL = process.env.CLASSAPP_GRAPHQL_URL || "https://web.classapp.com.br/graphql";
const CLASSAPP_LOCALE = process.env.CLASSAPP_LOCALE || "pt";
const MESSAGES_PAGE_SIZE = 25;

export class SessionExpiredError extends Error {
  constructor() {
    super(
      "Sessão do ClassApp expirada ou inválida.\n" +
        `Rode \`npm run login\`, acesse http://localhost:${process.env.NOVNC_PORT || 6080} e faça login novamente.`
    );
    this.name = "SessionExpiredError";
  }
}

export interface ClassAppClient {
  listStudentProfiles(): Promise<StudentProfile[]>;
  /** Retorna mensagens de um aluno, mais recentes primeiro, parando ao cruzar `since`. */
  listMessagesSince(args: { profileId: string; since: Date | null }): Promise<ClassAppMessageSummary[]>;
  listMessageImages(args: { profileId: string; messageId: string }): Promise<ClassAppAttachment[]>;
  downloadAttachment(attachmentUrl: string): Promise<Buffer>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/** tz_offset esperado pelo ClassApp é o oposto do sinal de Date.getTimezoneOffset(). */
function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * Cliente HTTP direto para a API GraphQL interna do ClassApp.
 * Endpoints e formatos documentados em docs/classapp-api.md.
 */
export async function createClassAppClient(): Promise<ClassAppClient> {
  const session = await loadSession();

  const http: AxiosInstance = axios.create({
    baseURL: CLASSAPP_GRAPHQL_URL,
    params: {
      client_id: session.clientId,
      tz_offset: tzOffsetMinutes(),
      locale: CLASSAPP_LOCALE,
    },
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
    },
    validateStatus: () => true,
  });

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await http.post<GraphQLResponse<T>>("", { query, variables });

    if (res.status === 401 || res.status === 403) {
      throw new SessionExpiredError();
    }
    if (res.status >= 400) {
      throw new Error(`ClassApp respondeu ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const errors = res.data?.errors;
    if (errors?.length) {
      const looksExpired = errors.some(
        (e) =>
          e.extensions?.code === "UNAUTHENTICATED" ||
          /auth|token|unauthorized/i.test(e.message)
      );
      if (looksExpired) throw new SessionExpiredError();
      throw new Error(`ClassApp GraphQL error: ${errors.map((e) => e.message).join("; ")}`);
    }

    if (!res.data?.data) {
      throw new Error("ClassApp respondeu sem dados.");
    }
    return res.data.data;
  }

  return {
    async listStudentProfiles() {
      const query = `
        query ListEntities {
          viewer {
            entities(limit: 100) {
              nodes { id: dbId type disabled fullname }
            }
          }
        }
      `;
      interface Result {
        viewer: { entities: { nodes: Array<{ id: string; type: string; disabled: boolean; fullname: string }> } };
      }
      const data = await graphql<Result>(query, {});
      return data.viewer.entities.nodes
        .filter((e) => e.type === "STUDENT" && !e.disabled)
        .map((e) => ({ id: e.id, name: e.fullname }));
    },

    async listMessagesSince({ profileId, since }) {
      const query = `
        query ListMessages($entityId: ID!, $limit: Int, $offset: Int) {
          node(id: $entityId) {
            ... on Entity {
              messages(limit: $limit, offset: $offset) {
                nodes { id: dbId created sentAt imagesCount }
                pageInfo { hasNextPage }
              }
            }
          }
        }
      `;
      interface Result {
        node: {
          messages: {
            nodes: Array<{ id: string; created: string; sentAt: string | null; imagesCount: number }>;
            pageInfo: { hasNextPage: boolean };
          };
        };
      }

      const messages: ClassAppMessageSummary[] = [];
      let offset = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const data = await graphql<Result>(query, { entityId: profileId, limit: MESSAGES_PAGE_SIZE, offset });
        const { nodes, pageInfo } = data.node.messages;

        for (const node of nodes) {
          const createdAt = node.sentAt ?? node.created;
          if (since && new Date(createdAt) < since) {
            return messages;
          }
          messages.push({ id: node.id, createdAt, imagesCount: node.imagesCount });
        }

        if (!pageInfo.hasNextPage) break;
        offset += MESSAGES_PAGE_SIZE;
      }

      return messages;
    },

    async listMessageImages({ profileId, messageId }) {
      const query = `
        query GetMessageImages($entityId: ID!, $messageId: ID!) {
          node(id: $entityId) {
            ... on Entity {
              message(id: $messageId) {
                images: medias(type: IMAGE, limit: 40) {
                  nodes { id: dbId original: uri(size: "w1280") mimetype origName }
                }
              }
            }
          }
        }
      `;
      interface Result {
        node: {
          message: {
            images: { nodes: Array<{ id: string; original: string; mimetype: string; origName: string }> };
          };
        };
      }
      const data = await graphql<Result>(query, { entityId: profileId, messageId });
      return data.node.message.images.nodes.map((m) => ({ id: m.id, url: m.original, filename: m.origName }));
    },

    /** URLs de imagem são servidas por images.classapp.com.br (CDN separado do GraphQL) e não exigem autenticação. */
    async downloadAttachment(attachmentUrl) {
      const res = await axios.get<ArrayBuffer>(attachmentUrl, {
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      if (res.status >= 400) {
        throw new Error(`Falha ao baixar anexo (${res.status}): ${attachmentUrl}`);
      }
      return Buffer.from(res.data);
    },
  };
}
