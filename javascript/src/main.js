/**
 * Contains the code executed in the sandboxed frame under web-browser
 *
 * Tries to create a Web-Worker inside the frame and set up the
 * communication between the worker and the parent window. Some
 * browsers restrict creating a worker inside a sandboxed iframe - if
 * this happens, the plugin initialized right inside the frame (in the
 * same thread)
 */
import PluginWorker from "./plugin.webworker.js";
import setupIframe from "./pluginIframe.js";
import {
  randId,
  normalizeConfig,
  setupServiceWorker,
  loadRequirements
} from "./utils.js";

export { RPC, API_VERSION } from "./rpc.js";
export { version as VERSION } from "../package.json";
export { loadRequirements };

function _inIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

function _inWebWorker() {
  return (
    typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope
  );
}

/**
 * Initializes the plugin inside a web worker. May throw an exception
 * in case this was not permitted by the browser.
 */
function setupWebWorker(config) {
  if (!config.allow_execution)
    throw new Error(
      "web-worker plugin can only work with allow_execution=true"
    );
  let broadcastChannel = null;
  if (config.broadcastChannel) {
    broadcastChannel = new BroadcastChannel(config.broadcastChannel);
  }
  const worker = new PluginWorker();
  // mixed content warning in Chrome silently skips worker
  // initialization without exception, handling this with timeout
  const fallbackTimeout = setTimeout(function() {
    worker.terminate();
    console.warn(
      `Plugin failed to start as a web-worker, running in an iframe instead.`
    );
    setupIframe(config);
  }, 2000);
  const peer_id = randId();

  // forwarding messages between the worker and parent window
  worker.addEventListener("message", function(e) {
    let transferables = undefined;
    const m = e.data;
    if (m.type === "worker-ready") {
      // send config to the worker
      worker.postMessage({ type: "connectRPC", config: config });
      clearTimeout(fallbackTimeout);
      return;
    } else if (m.type === "initialized") {
      // complete the missing fields
      m.config = Object.assign({}, config, m.config);
      m.origin = window.location.origin;
      m.peer_id = peer_id;
    } else if (m.type === "imjoy_remote_api_ready") {
      // if it's a webworker, there will be no api object returned
      window.dispatchEvent(
        new CustomEvent("imjoy_remote_api_ready", { detail: null })
      );
    } else if (
      m.type === "cacheRequirements" &&
      typeof cache_requirements === "function"
    ) {
      cache_requirements(m.requirements);
    } else if (m.type === "disconnect") {
      worker.terminate();
    } else {
      if (m.__transferables__) {
        transferables = m.__transferables__;
        delete m.__transferables__;
      }
    }
    if (broadcastChannel) broadcastChannel.postMessage(m);
    else parent.postMessage(m, config.target_origin || "*", transferables);
  });

  (broadcastChannel || window).addEventListener("message", function(e) {
    if (
      e.type === "message" &&
      (broadcastChannel ||
        config.target_origin === "*" ||
        e.origin === config.target_origin)
    ) {
      let transferables = undefined;
      const m = e.data;
      if (m.__transferables__) {
        transferables = m.__transferables__;
        delete m.__transferables__;
      }
      if (m.peer_id === peer_id) {
        worker.postMessage(m, transferables);
      } else if (config.debug) {
        console.log(`connection peer id mismatch ${m.peer_id} !== ${peer_id}`);
      }
    }
  });
}

export function waitForInitialization(config) {
  if (_inWebWorker()) {
    globalThis.parent = self;
  }
  config = config || {};
  if (config.enable_service_worker) {
    setupServiceWorker(
      config.base_url,
      config.target_origin,
      config.cache_requirements
    );
    config.enable_service_worker = false;
  }
  if (config.cache_requirements) {
    delete config.cache_requirements;
  }
  const targetOrigin = config.target_origin || "*";
  if (
    config.credential_required &&
    typeof config.verify_credential !== "function"
  ) {
    throw new Error(
      "Please also provide the `verify_credential` function with `credential_required`."
    );
  }
  if (config.credential_required && targetOrigin === "*") {
    throw new Error(
      "`target_origin` was set to `*` with `credential_required=true`, there is a security risk that you may leak the credential to website from other origin. Please specify the `target_origin` explicitly."
    );
  }
  const done = () => {
    globalThis.removeEventListener("message", handleEvent);
  };
  const peer_id = randId();
  const handleEvent = e => {
    if (
      e.type === "message" &&
      (!e.origin || targetOrigin === "*" || e.origin === targetOrigin)
    ) {
      if (e.data.type === "initialize") {
        done();
        if (e.data.peer_id !== peer_id) {
          // TODO: throw an error when we are sure all the peers will send the peer_id
          console.warn(
            `${e.data.config &&
              e.data.config.name}: connection peer id mismatch ${
              e.data.peer_id
            } !== ${peer_id}`
          );
        }
        const cfg = e.data.config;
        // override the target_origin setting if it's configured by the rpc client
        // otherwise take the setting from the core
        if (targetOrigin !== "*") {
          cfg.target_origin = targetOrigin;
        }
        if (config.credential_required) {
          config.verify_credential(cfg.credential).then(result => {
            if (result && result.auth && !result.error) {
              // pass the authentication information with tokens
              cfg.auth = result.auth;
              setupRPC(cfg).then(() => {
                console.log("ImJoy RPC loaded successfully!");
              });
            } else {
              throw new Error(
                "Failed to verify the credentail:" + (result && result.error)
              );
            }
          });
        } else {
          setupRPC(cfg).then(() => {
            console.log("ImJoy RPC loaded successfully!");
          });
        }
      } else {
        throw new Error(`unrecognized message: ${e.data}`);
      }
    }
  };
  globalThis.addEventListener("message", handleEvent);

  if (_inWebWorker()) {
    parent.postMessage({
      type: "imjoyRPCReady",
      config: config,
      peer_id: peer_id
    });
  } else {
    parent.postMessage(
      { type: "imjoyRPCReady", config: config, peer_id: peer_id },
      "*"
    );
  }
}

export function setupRPC(config) {
  config = config || {};
  config.name = config.name || randId();
  config = normalizeConfig(config);
  if (config.enable_service_worker) {
    setupServiceWorker(
      config.base_url,
      config.target_origin,
      config.cache_requirements
    );
  }
  if (config.cache_requirements) {
    delete config.cache_requirements;
  }
  return new Promise((resolve, reject) => {
    const handleEvent = e => {
      const api = e.detail;
      if (config.expose_api_globally) {
        globalThis.api = api;
      }
      // imjoy plugin api
      resolve(api);
      globalThis.removeEventListener("imjoy_remote_api_ready", handleEvent);
    };
    if (_inIframe()) {
      if (config.type === "web-worker") {
        try {
          setupWebWorker(config);
        } catch (e) {
          // fallback to iframe
          setupIframe(config);
        }
      } else if (
        ["rpc-window", "rpc-worker", "iframe", "window"].includes(config.type)
      ) {
        setupIframe(config);
      } else {
        console.error("Unsupported plugin type: " + config.type);
        reject("Unsupported plugin type: " + config.type);
        return;
      }
      globalThis.addEventListener("imjoy_remote_api_ready", handleEvent);
    } else if (_inWebWorker()) {
      // inside a webworker
      setupIframe(config);
    } else {
      reject(
        new Error("imjoy-rpc should only run inside an iframe or a webworker.")
      );
    }
  });
}
