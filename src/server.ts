import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { IncomingMessage, Server, ServerResponse } from "http";
import { z } from "zod";
import { FigmaService } from "./services/figma.js";
import { SimplifiedDesign } from "./services/simplify-node-response.js";
import express, { Request, Response } from "express";

export const Logger = {
  log: (...args: any[]) => {},
  error: (...args: any[]) => {},
};

// Define a type for the cache entries
interface CacheEntry {
  result: any;
  timestamp: number;
}

export class FigmaMcpServer {
  public readonly server: McpServer;
  private readonly figmaService: FigmaService;
  private transports: { [sessionId: string]: SSEServerTransport } = {};

  public hasTransport(sessionId: string): boolean {
    return !!this.transports[sessionId];
  }
  private httpServer: Server | null = null;
  // Add a cache object to store previously fetched Figma data
  private figmaDataCache: Record<string, CacheEntry> = {};
  // Cache expiration time (in milliseconds) - 5 minutes
  private cacheTTL: number = 5 * 60 * 1000;

  constructor(figmaApiKey: string) {
    this.figmaService = new FigmaService(figmaApiKey);
    this.server = new McpServer(
      {
        name: "Figma MCP Server",
        version: "0.1.18",
      },
      {
        capabilities: {
          logging: {},
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  private registerTools(): void {
    // Tool to get file information
    this.server.tool(
      "get_figma_data",
      "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
      {
        fileKey: z
          .string()
          .describe(
            "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
          ),
        nodeId: z
          .string()
          .optional()
          .describe(
            "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided",
          ),
        depth: z
          .number()
          .optional()
          .describe(
            "How many levels deep to traverse the node tree, only use if explicitly requested by the user",
          ),
      },
      async ({ fileKey, nodeId, depth }) => {
        try {
          // Generate a cache key based on the request parameters
          const cacheKey = `${fileKey}:${nodeId || "root"}:${depth || "all"}`;

          // Check if we have a valid cached response
          const now = Date.now();
          const cachedData = this.figmaDataCache[cacheKey];

          if (cachedData && now - cachedData.timestamp < this.cacheTTL) {
            Logger.log(`Using cached data for ${cacheKey}`);
            return cachedData.result;
          }

          Logger.log(
            `Fetching ${
              depth ? `${depth} layers deep` : "all layers"
            } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
          );

          let file: SimplifiedDesign;
          if (nodeId) {
            file = await this.figmaService.getNode(fileKey, nodeId, depth);
          } else {
            file = await this.figmaService.getFile(fileKey, depth);
          }

          Logger.log(`Successfully fetched file: ${file.name}`);
          const { nodes, globalVars, ...metadata } = file;

          const result = {
            metadata,
            nodes,
            globalVars,
          };

          // Format the response in a more AI-friendly way
          let summaryText = `# Figma File Summary\n\n`;
          summaryText += `## File Information\n`;
          summaryText += `- Name: ${metadata.name}\n`;
          summaryText += `- Last Modified: ${metadata.lastModified || "Unknown"}\n`;
          summaryText += `- Thumbnail URL: ${metadata.thumbnailUrl || "Unknown"}\n\n`;

          // Add node structure summary
          summaryText += `## Node Structure\n`;

          // Count nodes by type
          const nodeTypes: Record<string, number> = {};
          const countNodeTypes = (nodesObj: any) => {
            for (const nodeId in nodesObj) {
              const node = nodesObj[nodeId];
              if (node.type) {
                nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
              }
              if (node.children) {
                countNodeTypes(node.children);
              }
            }
          };

          countNodeTypes(nodes);

          for (const [type, count] of Object.entries(nodeTypes)) {
            summaryText += `- ${type}: ${count}\n`;
          }

          summaryText += `\n## Data Available\n`;
          summaryText += `- Full node structure data is available\n`;
          if (globalVars && Object.keys(globalVars).length > 0) {
            summaryText += `- Global variables are available\n`;
          }

          summaryText += `\n---\n\nThis is the complete summary of the Figma file. Use this information to determine what UI elements are available for implementation.`;

          const response = {
            content: [{ type: "text", text: summaryText }],
          };

          // Store in cache
          this.figmaDataCache[cacheKey] = {
            result: response,
            timestamp: now,
          };

          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          Logger.error(`Error fetching file ${fileKey}:`, message);
          return {
            isError: true,
            content: [{ type: "text", text: `Error fetching file: ${message}` }],
          };
        }
      },
    );

    // TODO: Clean up all image download related code, particularly getImages in Figma service
    // Tool to download images
    this.server.tool(
      "download_figma_images",
      "Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes",
      {
        fileKey: z.string().describe("The key of the Figma file containing the node"),
        nodes: z
          .object({
            nodeId: z
              .string()
              .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
            imageRef: z
              .string()
              .optional()
              .describe(
                "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
              ),
            fileName: z.string().describe("The local name for saving the fetched file"),
          })
          .array()
          .describe("The nodes to fetch as images"),
        localPath: z
          .string()
          .describe(
            "The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
          ),
      },
      async ({ fileKey, nodes, localPath }) => {
        try {
          const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
            nodeId: string;
            imageRef: string;
            fileName: string;
          }[];
          const fillDownloads = this.figmaService.getImageFills(fileKey, imageFills, localPath);
          const renderRequests = nodes
            .filter(({ imageRef }) => !imageRef)
            .map(({ nodeId, fileName }) => ({
              nodeId,
              fileName,
              fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
            }));

          const renderDownloads = this.figmaService.getImages(fileKey, renderRequests, localPath);

          const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
            ...f,
            ...r,
          ]);

          // If any download fails, return false
          const saveSuccess = !downloads.find((success) => !success);
          return {
            content: [
              {
                type: "text",
                text: saveSuccess
                  ? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}`
                  : "Failed",
              },
            ],
          };
        } catch (error) {
          Logger.error(`Error downloading images from file ${fileKey}:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error downloading images: ${error}` }],
          };
        }
      },
    );
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);

    Logger.log = (...args: any[]) => {
      // this.server.server.sendLoggingMessage({
      //   level: "info",
      //   data: args,
      // });
      console.error("[INFO]", ...args);
    };
    Logger.error = (...args: any[]) => {
      // this.server.server.sendLoggingMessage({
      //   level: "error",
      //   data: args,
      // });
      console.error("[ERROR]", ...args);
    };

    // Ensure stdout is only used for JSON messages
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
      // Only allow JSON messages to pass through
      if (typeof chunk === "string" && !chunk.startsWith("{")) {
        return true; // Silently skip non-JSON messages
      }
      return originalStdoutWrite(chunk, encoding, callback);
    };

    Logger.log("Server connected and ready to process requests");
  }

  async startHttpServer(port: number): Promise<void> {
    const app = express();

    app.get("/sse", async (req: Request, res: Response) => {
      console.log("Establishing new SSE connection");
      const transport = new SSEServerTransport(
        "/messages",
        res as unknown as ServerResponse<IncomingMessage>,
      );
      console.log(`New SSE connection established for sessionId ${transport.sessionId}`);

      this.transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete this.transports[transport.sessionId];
      });

      await this.server.connect(transport);
    });

    app.post("/messages", async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      if (!this.transports[sessionId]) {
        res.status(400).send(`No transport found for sessionId ${sessionId}`);
        return;
      }
      console.log(`Received message for sessionId ${sessionId}`);
      await this.transports[sessionId].handlePostMessage(req, res);
    });

    Logger.log = console.log;
    Logger.error = console.error;

    this.httpServer = app.listen(port, () => {
      Logger.log(`HTTP server listening on port ${port}`);
      Logger.log(`SSE endpoint available at http://localhost:${port}/sse`);
      Logger.log(`Message endpoint available at http://localhost:${port}/messages`);
    });
  }

  async stopHttpServer(): Promise<void> {
    if (!this.httpServer) {
      throw new Error("HTTP server is not running");
    }

    return new Promise((resolve, reject) => {
      this.httpServer!.close((err: Error | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        this.httpServer = null;
        const closing = Object.values(this.transports).map((transport) => {
          return transport.close();
        });
        Promise.all(closing).then(() => {
          resolve();
        });
      });
    });
  }

  // Fixing the private access issue by adding a public getter for transports
  public getTransports() {
    return this.transports;
  }
}

export async function startHttpServer(server: FigmaMcpServer, port: number): Promise<void> {
  await server.startHttpServer(port);
}

export default async function handler(req: Request, res: Response) {
  const figmaApiKey = process.env.FIGMA_API_KEY || "";
  const server = new FigmaMcpServer(figmaApiKey);

  if (req.method === "GET" && req.url?.startsWith("/sse")) {
    const transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
  } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
    const sessionId = req.query.sessionId as string;
    if (!server.getTransports()[sessionId]) {
      res.status(400).send(`No transport found for sessionId ${sessionId}`);
      return;
    }
    await server.getTransports()[sessionId].handlePostMessage(req, res);
  } else {
    res.status(404).send("Not Found");
  }
}
