const express = require("express");
const https = require("https");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const Database = require("./database");
const util = require("util");
const { CacheableDnsHttpAgent } = require("./cacheable-dns-http-agent");
const { Settings } = require("./settings");
const dayjs = require("dayjs");
// DO NOT IMPORT HERE IF THE MODULES USED `UptimeKumaServer.getInstance()`

/**
 * `module.exports` (alias: `server`) should be inside this class, in order to avoid circular dependency issue.
 * @type {UptimeKumaServer}
 */
class UptimeKumaServer {
    /**
     *
     * @type {UptimeKumaServer}
     */
    static instance = null;

    /**
     * Main monitor list
     * @type {{}}
     */
    monitorList = {};

    /**
     * Main maintenance list
     * @type {{}}
     */
    maintenanceList = {};

    entryPage = "dashboard";
    app = undefined;
    httpServer = undefined;
    io = undefined;

    /**
     * Cache Index HTML
     * @type {string}
     */
    indexHTML = "";

    generateMaintenanceTimeslotsInterval = undefined;

    static getInstance(args) {
        if (UptimeKumaServer.instance == null) {
            UptimeKumaServer.instance = new UptimeKumaServer(args);
        }
        return UptimeKumaServer.instance;
    }

    constructor(args) {
        // SSL
        const sslKey = args["ssl-key"] || process.env.UPTIME_KUMA_SSL_KEY || process.env.SSL_KEY || undefined;
        const sslCert = args["ssl-cert"] || process.env.UPTIME_KUMA_SSL_CERT || process.env.SSL_CERT || undefined;

        log.info("server", "Creating express and socket.io instance");
        this.app = express();
        if (sslKey && sslCert) {
            log.info("server", "Server Type: HTTPS");
            this.httpServer = https.createServer({
                key: fs.readFileSync(sslKey),
                cert: fs.readFileSync(sslCert)
            }, this.app);
        } else {
            log.info("server", "Server Type: HTTP");
            this.httpServer = http.createServer(this.app);
        }

        try {
            this.indexHTML = fs.readFileSync("./dist/index.html").toString();
        } catch (e) {
            // "dist/index.html" is not necessary for development
            if (process.env.NODE_ENV !== "development") {
                log.error("server", "Error: Cannot find 'dist/index.html', did you install correctly?");
                process.exit(1);
            }
        }

        this.io = new Server(this.httpServer);
    }

    async initAfterDatabaseReady() {
        await CacheableDnsHttpAgent.update();

        process.env.TZ = await this.getTimezone();
        dayjs.tz.setDefault(process.env.TZ);
        log.debug("DEBUG", "Timezone: " + process.env.TZ);
        log.debug("DEBUG", "Current Time: " + dayjs.tz().format());

        await this.generateMaintenanceTimeslots();
        this.generateMaintenanceTimeslotsInterval = setInterval(this.generateMaintenanceTimeslots, 60 * 1000);
    }

    async sendMonitorList(socket) {
        let list = await this.getMonitorJSONList(socket.userID);
        this.io.to(socket.userID).emit("monitorList", list);
        return list;
    }

    /**
     * Get a list of monitors for the given user.
     * @param {string} userID - The ID of the user to get monitors for.
     * @returns {Promise<Object>} A promise that resolves to an object with monitor IDs as keys and monitor objects as values.
     *
     * Generated by Trelent
     */
    async getMonitorJSONList(userID) {
        let result = {};

        let monitorList = await R.find("monitor", " user_id = ? ORDER BY weight DESC, name", [
            userID,
        ]);

        for (let monitor of monitorList) {
            result[monitor.id] = await monitor.toJSON();
        }

        return result;
    }

    /**
     * Send maintenance list to client
     * @param {Socket} socket Socket.io instance to send to
     * @returns {Object}
     */
    async sendMaintenanceList(socket) {
        return await this.sendMaintenanceListByUserID(socket.userID);
    }

    async sendMaintenanceListByUserID(userID) {
        let list = await this.getMaintenanceJSONList(userID);
        this.io.to(userID).emit("maintenanceList", list);
        return list;
    }

    /**
     * Get a list of maintenances for the given user.
     * @param {string} userID - The ID of the user to get maintenances for.
     * @returns {Promise<Object>} A promise that resolves to an object with maintenance IDs as keys and maintenances objects as values.
     */
    async getMaintenanceJSONList(userID) {
        let result = {};

        let maintenanceList = await R.find("maintenance", " user_id = ? ORDER BY end_date DESC, title", [
            userID,
        ]);

        for (let maintenance of maintenanceList) {
            result[maintenance.id] = await maintenance.toJSON();
        }

        return result;
    }

    /**
     * Write error to log file
     * @param {any} error The error to write
     * @param {boolean} outputToConsole Should the error also be output to console?
     */
    static errorLog(error, outputToConsole = true) {
        const errorLogStream = fs.createWriteStream(Database.dataDir + "/error.log", {
            flags: "a"
        });

        errorLogStream.on("error", () => {
            log.info("", "Cannot write to error.log");
        });

        if (errorLogStream) {
            const dateTime = R.isoDateTime();
            errorLogStream.write(`[${dateTime}] ` + util.format(error) + "\n");

            if (outputToConsole) {
                console.error(error);
            }
        }

        errorLogStream.end();
    }

    async getClientIP(socket) {
        // Check if cloudflare connecting IP for real IP in proxy tunnels
        let clientIP = socket.client.conn.request.headers["cf-connecting-ip"] || socket.client.conn.remoteAddress;

        if (clientIP === undefined) {
            clientIP = "";
        }

        if (await Settings.get("trustProxy")) {
            const forwardedFor = socket.client.conn.request.headers["x-forwarded-for"];

            return (typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : null)
                || socket.client.conn.request.headers["x-real-ip"]
                || clientIP.replace(/^.*:/, "");
        } else {
            return clientIP.replace(/^.*:/, "");
        }
    }

    async getTimezone() {
        let timezone = await Settings.get("serverTimezone");
        if (timezone) {
            return timezone;
        } else if (process.env.TZ) {
            return process.env.TZ;
        } else {
            return dayjs.tz.guess();
        }
    }

    getTimezoneOffset() {
        return dayjs().format("Z");
    }

    async setTimezone(timezone) {
        await Settings.set("serverTimezone", timezone, "general");
        process.env.TZ = timezone;
        dayjs.tz.setDefault(timezone);
    }

    async generateMaintenanceTimeslots() {

        let list = await R.find("maintenance_timeslot", " generated_next = 0 AND start_date <= DATETIME('now') ");

        for (let maintenanceTimeslot of list) {
            let maintenance = await maintenanceTimeslot.maintenance;
            await MaintenanceTimeslot.generateTimeslot(maintenance, maintenanceTimeslot.end_date, false);
            maintenanceTimeslot.generated_next = true;
            await R.store(maintenanceTimeslot);
        }

    }

    async stop() {
        clearTimeout(this.generateMaintenanceTimeslotsInterval);
    }
}

module.exports = {
    UptimeKumaServer
};

// Must be at the end
const MaintenanceTimeslot = require("./model/maintenance_timeslot");
