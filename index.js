"use strict";

const utils = require("./utils");
const log = require("npmlog");
const { execSync, exec } = require("child_process");
const { promises: fsPromises, readFileSync } = require("fs");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const models = require("./lib/database/models");
const logger = require("./lib/logger");

// ==========================
// Default Config Section
// ==========================
const defaultLogRecordSize = 100;
log.maxRecordSize = defaultLogRecordSize;

const defaultConfig = {
  autoUpdate: true,
  mqtt: {
    enabled: true,
    reconnectInterval: 3600,
  },
};

const configPath = path.join(process.cwd(), "fca-nazrul.json");
let config;

if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  config = defaultConfig;
} else {
  try {
    const fileContent = fs.readFileSync(configPath, "utf8");
    const parsedConfig = JSON.parse(fileContent);
    config = { ...defaultConfig, ...parsedConfig };
  } catch (err) {
    log.error("Config", "Error reading config file, using defaults");
    config = defaultConfig;
  }
}

global.fca = { config };

// ==========================
// Option Settings
// ==========================
const Boolean_Option = [
  "online",
  "selfListen",
  "listenEvents",
  "updatePresence",
  "forceLogin",
  "autoMarkDelivery",
  "autoMarkRead",
  "listenTyping",
  "autoReconnect",
  "emitReady",
];

function setOptions(globalOptions, options) {
  Object.keys(options).forEach(function (key) {
    if (Boolean_Option.includes(key)) {
      globalOptions[key] = Boolean(options[key]);
    } else {
      switch (key) {
        case "pauseLog":
          options.pauseLog ? log.pause() : log.resume();
          break;
        case "logLevel":
          log.level = options.logLevel;
          globalOptions.logLevel = options.logLevel;
          break;
        case "logRecordSize":
          log.maxRecordSize = options.logRecordSize;
          globalOptions.logRecordSize = options.logRecordSize;
          break;
        case "pageID":
          globalOptions.pageID = options.pageID.toString();
          break;
        case "userAgent":
          globalOptions.userAgent =
            options.userAgent ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
          break;
        case "proxy":
          if (typeof options.proxy !== "string") {
            delete globalOptions.proxy;
            utils.setProxy();
          } else {
            globalOptions.proxy = options.proxy;
            utils.setProxy(globalOptions.proxy);
          }
          break;
        default:
          log.warn("setOptions", `Unrecognized option: ${key}`);
          break;
      }
    }
  });
}

// ==========================
// Build API Section
// ==========================
function buildAPI(globalOptions, html, jar) {
  const cookies = jar.getCookies("https://www.facebook.com");
  const userCookie = cookies.find((c) => c.cookieString().startsWith("c_user="));
  const tiktikCookie = cookies.find((c) => c.cookieString().startsWith("i_user="));

  if (!userCookie && !tiktikCookie) {
    return log.error("login", "No cookies found for the user, please check your login information again");
  }

  if (html.includes("/checkpoint/block/?next")) {
    return log.error("login", "APPSTATE IS DEAD, PLEASE REPLACE WITH A NEW APPSTATE");
  }

  const userID = (tiktikCookie || userCookie).cookieString().split("=")[1];
  const i_userID = tiktikCookie ? tiktikCookie.cookieString().split("=")[1] : null;

  logger.info(`Logged in as ${userID}`);

  const clientID = ((Math.random() * 2147483648) | 0).toString(16);
  let mqttEndpoint, region, fb_dtsg, irisSeqID;

  try {
    const endpointMatch = html.match(/"endpoint":"([^"]+)"/);
    if (endpointMatch) {
      mqttEndpoint = endpointMatch[1].replace(/\\\//g, "/");
      const url = new URL(mqttEndpoint);
      region = url.searchParams.get("region")?.toUpperCase() || "PRN";
      logger.info(`Server region: ${region}`);
    }
  } catch {
    log.warn("login", "No MQTT endpoint found");
  }

  const tokenMatch = html.match(/DTSGInitialData.*?token":"(.*?)"/);
  if (tokenMatch) fb_dtsg = tokenMatch[1];

  // Database Sync
  (async () => {
    try {
      await models.sequelize.authenticate();
      await models.syncAll();
      logger.info("Database connected successfully");
    } catch (error) {
      log.error("Database", `Connection failed: ${error.message}`);
    }
  })();

  const ctx = {
    userID,
    i_userID,
    jar,
    clientID,
    globalOptions,
    loggedIn: true,
    access_token: "NONE",
    clientMutationId: 0,
    mqttClient: undefined,
    lastSeqId: irisSeqID,
    syncToken: undefined,
    mqttEndpoint,
    region,
    firstListen: true,
    fb_dtsg,
    wsReqNumber: 0,
    wsTaskNumber: 0,
  };

  const api = {
    setOptions: setOptions.bind(null, globalOptions),
    getAppState: function () {
      const appState = utils.getAppState(jar);
      return appState.filter(
        (item, index, self) =>
          self.findIndex((t) => t.key === item.key) === index
      );
    },
  };

  const defaultFuncs = utils.makeDefaults(html, i_userID || userID, ctx);

  fs.readdirSync(path.join(__dirname, "src"))
    .filter((v) => v.endsWith(".js"))
    .forEach((v) => {
      api[v.replace(".js", "")] = require(`./src/${v}`)(defaultFuncs, api, ctx);
    });

  api.listen = api.listenMqtt;

  // Auto refresh fb_dtsg every 24h
  setInterval(async () => {
    if (api.refreshFb_dtsg) {
      try {
        await api.refreshFb_dtsg();
        logger.info("Successfully refreshed fb_dtsg");
      } catch (err) {
        log.error("fb_dtsg", `Error refreshing: ${err.message}`);
      }
    }
  }, 1000 * 60 * 60 * 24);

  return { ctx, defaultFuncs, api };
}

// ==========================
// Login Helper Section
// ==========================
function loginHelper(appState, email, password, globalOptions, callback) {
  const jar = utils.getJar();
  let mainPromise;

  // Load AppState cookies
  if (appState) {
    if (typeof appState === "string") {
      try {
        appState = JSON.parse(appState);
      } catch {
        return callback(new Error("Failed to parse appState JSON"));
      }
    }

    try {
      appState.forEach((c) => {
        const str = `${c.key}=${c.value}; expires=${c.expires}; domain=${c.domain}; path=${c.path};`;
        jar.setCookie(str, "https://" + c.domain);
      });

      mainPromise = utils
        .get("https://www.facebook.com/", jar, null, globalOptions, { noRef: true })
        .then(utils.saveCookies(jar));
    } catch (e) {
      return callback(e);
    }
  } else {
    mainPromise = utils
      .get("https://www.facebook.com/", null, null, globalOptions, { noRef: true })
      .then(utils.saveCookies(jar))
      .then(() => utils.get("https://www.facebook.com/", jar, null, globalOptions).then(utils.saveCookies(jar)));
  }

  function handleRedirect(res) {
    const reg = /<meta http-equiv="refresh" content="0;url=([^"]+)[^>]+>/;
    const redirect = reg.exec(res.body);
    if (redirect && redirect[1]) {
      return utils.get(redirect[1], jar, null, globalOptions).then(utils.saveCookies(jar));
    }
    return res;
  }

  let ctx, api;

  mainPromise = mainPromise
    .then(handleRedirect)
    .then((res) => {
      const html = res.body;
      const Obj = buildAPI(globalOptions, html, jar);
      ctx = Obj.ctx;
      api = Obj.api;
      return res;
    })
    .then(async () => {
      log.info("FCA-NAZRUL", "Login successful!");
      callback(null, api);
    })
    .catch((e) => {
      callback(e);
    });
}

// ==========================
// Main Exported Login Function
// ==========================
function login(loginData, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  const globalOptions = {
    selfListen: false,
    selfListenEvent: false,
    listenEvents: false,
    listenTyping: false,
    updatePresence: false,
    forceLogin: false,
    autoMarkDelivery: true,
    autoMarkRead: false,
    autoReconnect: true,
    logRecordSize: defaultLogRecordSize,
    online: true,
    emitReady: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  };

  setOptions(globalOptions, options);

  let prCallback = null;
  if (typeof callback !== "function") {
    let rejectFunc, resolveFunc;
    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    prCallback = function (error, api) {
      if (error) rejectFunc(error);
      else resolveFunc(api);
    };

    callback = prCallback;
    loginHelper(loginData.appState, loginData.email, loginData.password, globalOptions, callback);
    return returnPromise;
  }

  loginHelper(loginData.appState, loginData.email, loginData.password, globalOptions, callback);
}

module.exports = login;
