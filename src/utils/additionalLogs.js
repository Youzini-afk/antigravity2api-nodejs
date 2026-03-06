import config from '../config/config.js';
import { randomUUID } from 'crypto';

export function createLog1(conversationId, token, sessionId) {
  const now = Date.now();
  const timestampMs = String(now);
  
  return {
    sessionInfo: { value: 16 },
    sequenceNumber: 2747,
    events: [{
      timestampMs,
      metadata: {
        operationEvent: {
          eventName: "TRAJECTORY_INTERFACE_OPERATION",
          properties: [
            { key: "ideName", value: "antigravity" },
            { key: "os", value: "windows" },
            { key: "machineId", value: token.deviceId },
            { key: "operation", value: "Step" },
            { key: "duration_us", value: "0" },
            { key: "cascade_id", value: conversationId },
            { key: "num_steps", value: "5" },
            { key: "ideVersion", value: config.api.ideVersion }
          ]
        },
        appName: "antigravity",
        version: config.api.ideVersion,
        os: "windows",
        arch: "amd64",
        tier: token.sub || "free-tier",
        unknownField_24: 1,
        region: "JP"
      },
      eventType: 5
    }],
    timestamp: String(now + 879)
  };
}

export function createLog2(conversationId, token, sessionId) {
  const now = Date.now();
  const t1 = now;
  const t2 = t1;
  const t3 = t1;
  const t4 = t1 + 154;
  const t5 = t1 + 154;
  const t6 = t1 + 156;
  const t7 = t1 + 156;
  const traceId = randomUUID();
  
  const seconds1 = String(Math.floor(t1 / 1000));
  const seconds2 = String(Math.floor(t2 / 1000));
  const seconds3 = String(Math.floor(t3 / 1000));
  const seconds4 = String(Math.floor(t4 / 1000));
  const seconds5 = String(Math.floor(t5 / 1000));
  const seconds6 = String(Math.floor(t6 / 1000));
  const seconds7 = String(Math.floor(t7 / 1000));
  
  return {
    sessionInfo: { value: 16 },
    sequenceNumber: 2747,
    events: [
      {
        timestampMs: String(t1),
        metadata: {
          sessionEvent: {
            sessionId,
            conversationId,
            turnNumber: 4,
            messageIndex: 1,
            timing: {
              timestamp: {
                seconds: seconds1,
                nanos: Math.floor(Math.random() * 100000000)
              },
              traceId
            },
            version: config.api.ideVersion,
            app: "antigravity",
            platform: "windows"
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: "",
          unknownField_24: 1,
          region: ""
        },
        eventType: 10
      },
      {
        timestampMs: String(t2),
        metadata: {
          fileEvent: {
            operation: {
              timestamp: {
                seconds: seconds2,
                nanos: Math.floor(Math.random() * 100000000)
              },
              traceId
            }
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: "",
          unknownField_24: 1,
          region: ""
        },
        eventType: 12
      },
      {
        timestampMs: String(t3),
        metadata: {
          operationEvent: {
            eventName: "LS_BINARY_STARTUP",
            properties: [
              { key: "os", value: "windows" },
              { key: "machineId", value: token.deviceId },
              { key: "durationMs", value: "2138" },
              { key: "ideVersion", value: config.api.ideVersion },
              { key: "ideName", value: "antigravity" }
            ]
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: "",
          unknownField_24: 1,
          region: ""
        },
        eventType: 5
      },
      {
        timestampMs: String(t4),
        metadata: {
          messageEvent: {
            messageData: {
              type: 14,
              status: 3,
              details: {
                startTime: {
                  seconds: seconds4,
                  nanos: Math.floor(Math.random() * 100000000)
                },
                state: 4,
                messageId: "",
                turnInfo: { sessionId, conversationId },
                stateTransitions: [{
                  info: {
                    state: 3,
                    timestamp: {
                      seconds: seconds4,
                      nanos: Math.floor(200000000 + Math.random() * 50000000)
                    }
                  }
                }]
              }
            },
            turnInfo: { sessionId, turnNumber: 4 },
            sessionId,
            messageId: "",
            status: 0,
            error: ""
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: token.sub || "free-tier",
          unknownField_24: 1,
          region: "JP"
        },
        eventType: 11
      },
      {
        timestampMs: String(t5),
        metadata: {
          messageEvent: {
            messageData: {
              type: 90,
              status: 3,
              details: {
                startTime: {
                  seconds: seconds5,
                  nanos: Math.floor(200000000 + Math.random() * 50000000)
                },
                state: 5,
                endTime: {
                  seconds: seconds5,
                  nanos: Math.floor(200000000 + Math.random() * 50000000)
                },
                messageId: "",
                turnInfo: { sessionId, turnState: 3, conversationId },
                stateTransitions: [{
                  info: {
                    state: 3,
                    timestamp: {
                      seconds: seconds5,
                      nanos: Math.floor(200000000 + Math.random() * 50000000)
                    }
                  }
                }]
              }
            },
            turnInfo: { sessionId, turnState: 3, turnNumber: 4 },
            sessionId,
            messageId: "",
            status: 0,
            error: ""
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: token.sub || "free-tier",
          unknownField_24: 1,
          region: "JP"
        },
        eventType: 11
      },
      {
        timestampMs: String(t6),
        metadata: {
          messageEvent: {
            messageData: {
              type: 98,
              status: 3,
              details: {
                startTime: {
                  seconds: seconds6,
                  nanos: Math.floor(200000000 + Math.random() * 50000000)
                },
                state: 5,
                endTime: {
                  seconds: seconds6,
                  nanos: Math.floor(200000000 + Math.random() * 50000000)
                },
                messageId: "",
                turnInfo: { sessionId, turnState: 1, conversationId },
                stateTransitions: [{
                  info: {
                    state: 3,
                    timestamp: {
                      seconds: seconds6,
                      nanos: Math.floor(200000000 + Math.random() * 50000000)
                    }
                  }
                }]
              }
            },
            turnInfo: { sessionId, turnState: 1, turnNumber: 4 },
            sessionId,
            messageId: "",
            status: 0,
            error: ""
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: token.sub || "free-tier",
          unknownField_24: 1,
          region: "JP"
        },
        eventType: 11
      },
      {
        timestampMs: String(t7),
        metadata: {
          messageEvent: {
            messageData: {
              type: 99,
              status: 3,
              details: {
                startTime: {
                  seconds: seconds7,
                  nanos: Math.floor(200000000 + Math.random() * 50000000)
                },
                state: 5,
                endTime: {
                  seconds: seconds7,
                  nanos: Math.floor(200000000 + Math.random() * 50000000)
                },
                messageId: "",
                turnInfo: { sessionId, turnState: 2, conversationId },
                stateTransitions: [{
                  info: {
                    state: 3,
                    timestamp: {
                      seconds: seconds7,
                      nanos: Math.floor(200000000 + Math.random() * 50000000)
                    }
                  }
                }]
              }
            },
            turnInfo: { sessionId, turnState: 2, turnNumber: 4 },
            sessionId,
            messageId: "",
            status: 0,
            error: ""
          },
          appName: "antigravity",
          version: config.api.ideVersion,
          os: "windows",
          arch: "amd64",
          tier: token.sub || "free-tier",
          unknownField_24: 1,
          region: "JP"
        },
        eventType: 11
      }
    ],
    timestamp: String(now + 395)
  };
}
