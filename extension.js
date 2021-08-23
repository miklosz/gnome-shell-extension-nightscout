const St             = imports.gi.St;
const Main           = imports.ui.main;
const MessageTray    = imports.ui.messageTray;
const Soup           = imports.gi.Soup;
const Lang           = imports.lang;
const Mainloop       = imports.mainloop;
const Clutter        = imports.gi.Clutter;
const PanelMenu      = imports.ui.panelMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Gtk            = imports.gi.Gtk;
const Gio            = imports.gi.Gio;
const Gettext        = imports.gettext;


// TODO: Localize messages
const messages = {
    prizeGlucoseNotification: {
        title: "Prize! You got {glucose}!",
        description: "Your glucose is now {glucose} mg/dl, congratulations!",
    },
    highGlucoseNotification: {
        title: "Your blood glucose is high!",
        description: "Your glucose is now {glucose} mg/dl.",
    },
    urgentHighGlucoseNotification: {
        title: "Your blood glucose is too high!",
        description: "Your glucose is now {glucose} mg/dl.",
    },
    lowGlucoseNotification: {
        title: "Your blood glucose is low!",
        description: "Your glucose is now {glucose} mg/dl.",
    },
    urgentLowGlucoseNotification: {
        title: "Your blood glucose is too low!",
        description: "Your glucose is now {glucose} mg/dl.",
    },
    expiredDataNotification: {
        title: "You have missing readings!",
        description: "There is no new readings since {elapsed} seconds ago.",
    },
    fallingDownGlucoseNotification: {
        title: "Your blood glucose is falling down fastly!",
        description:
            "Your glucose is falling down at ↓{delta} mg/dl since last reading.",
    },
    raisingUpGlucoseNotification: {
        title: "Your blood glucose is raising up fastly!",
        description:
            "Your glucose is raising up at ↑{delta} mg/dl since last reading.",
    },
};

const Nightscout = new Lang.Class(
    {
        Name: "Nightscout",
        Extends: PanelMenu.Button,
        source: null,
        settings: null,
        updateInterval: 30,
        httpSession: null,
        nightscoutUrl: null,
        notifications: {
            prizeGlucoseNotification: null,
            highGlucoseNotification: null,
            lowGlucoseNotification: null,
            expiredDataNotification: null,
            fallingDownGlucoseNotification: null,
            raisingUpGlucoseNotification: null,
        },
        alerts: {
            urgentLow: {
                value: 0,
                enabled: false,
            },
            low: {
                value: 0,
                enabled: false,
            },
            high: {
                value: 0,
                enabled: false,
            },
            urgentHigh: {
                value: 0,
                enabled: false,
            },
            raisingGlucose: {
                value: 10,
            },
            fallingGlucose: {
                value: -10,
            },
            glucoseVariability: {
                enabled: false
            }
        },
        _init: function () {
            this.parent(0.0, "Nightscout", false);
            this.buttonText = new St.Label(
                {
                    text: "Loading...",
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: "fresh-data",
                }
            );

            this.settings      = this._getSettings();
            this.nightscoutUrl = this.settings.get_string("nightscout-url");

            this.alerts.urgentLow.value            = this.settings.get_int("urgent-low-alert");
            this.alerts.urgentLow.enabled          = this.settings.get_boolean("urgent-low-alert-enabled");
            this.alerts.low.value                  = this.settings.get_int("low-alert");
            this.alerts.low.enabled                = this.settings.get_boolean("low-alert-enabled");
            this.alerts.high.value                 = this.settings.get_int("high-alert");
            this.alerts.high.enabled               = this.settings.get_boolean("high-alert-enabled");
            this.alerts.urgentHigh.value           = this.settings.get_int("urgent-high-alert");
            this.alerts.urgentHigh.enabled         = this.settings.get_boolean("urgent-high-alert-enabled");
            this.alerts.fallingGlucose.value       = this.settings.get_int("falling-glucose-alert");
            this.alerts.raisingGlucose.value       = this.settings.get_int("raising-glucose-alert");
            this.alerts.glucoseVariability.enabled = this.settings.get_boolean("glucose-variability-alert-enabled");

            this.httpSession = new Soup.Session();
            this.actor.add_actor(this.buttonText);

            this._buildAndAttachSource();

            this._initIcons();
            this._refresh();
        },
        _getSettings: function () {
            let extension = ExtensionUtils.getCurrentExtension();
            let schema    = extension.metadata["settings-schema"];

            const GioSSS  = Gio.SettingsSchemaSource;
            let schemaDir = extension.dir.get_child("schemas");
            let schemaSource;
            if (schemaDir.query_exists(null))
                schemaSource = GioSSS.new_from_directory(
                    schemaDir.get_path(),
                    GioSSS.get_default(),
                    false
                );
            else schemaSource = GioSSS.get_default();

            let schemaObj = schemaSource.lookup(schema, true);
            if (!schemaObj)
                throw new Error(
                    "Schema " +
                    schema +
                    " could not be found for extension " +
                    extension.metadata.uuid +
                    ". Please check your installation."
                );

            return new Gio.Settings({settings_schema: schemaObj});
        },
        _refresh: function () {
            this._loadData();
            this._removeTimeout();
            this._timeout = Mainloop.timeout_add_seconds(
                this.updateInterval,
                Lang.bind(this, this._refresh)
            );
            return true;
        },
        _removeTimeout: function () {
            if (this._timeout) {
                Mainloop.source_remove(this._timeout);
                this._timeout = null;
            }
        },
        _initIcons: function () {
            let extension = ExtensionUtils.getCurrentExtension();
            let theme     = Gtk.IconTheme.get_default();
            let iconDir   = extension.dir.get_child("icons");
            if (iconDir.query_exists(null)) {
                theme.append_search_path(iconDir.get_path());
            }
        },
        _buildAndAttachSource: function () {
            this.source = new MessageTray.SystemNotificationSource();
            this.source.connect("destroy", () => (this.source = null));
            Main.messageTray.add(this.source);
        },
        _parseUrl: function (urlString) {
            const queryStart = urlString.indexOf("?");

            let hashes = urlString.slice(queryStart + 1).split("&");
            return {
                baseUrl: urlString.substring(0, queryStart).replace(/\/$/, ""),
                queryParams: hashes.reduce((params, hash) => {
                    let [key, val] = hash.split("=");
                    return Object.assign(params, {[key]: decodeURIComponent(val)});
                }, {}),
            };
        },
        _serializeUrl: function (url) {
            const str = [];
            for (const p in url.queryParams)
                if (url.queryParams.hasOwnProperty(p)) {
                    str.push(
                        encodeURIComponent(p) + "=" + encodeURIComponent(url.queryParams[p])
                    );
                }
            return url.baseUrl + "?" + str.join("&");
        },
        _checkUpdates: function () {
            let url                  = this._parseUrl(this.nightscoutUrl);
            url.baseUrl += "/api/v1/entries.json";
            url.queryParams["count"] = 1;

            let message = Soup.form_request_new_from_hash(
                "GET",
                this._serializeUrl(url),
                {}
            );

            this.httpSession.queue_message(
                message,
                Lang.bind(this, function (_httpSession, message) {
                    if (message.status_code !== 200) {
                        return;
                    }

                    let json;

                    try {
                        json = JSON.parse(message.response_body.data);
                    } catch (e) {
                        this.buttonText.set_text(`No data`);
                        return;
                    }

                    let entry = json[0];

                    if (typeof entry === "undefined") {
                        this.buttonText.set_text(`No data`);
                        return;
                    }

                    let glucoseValue   = entry.sgv;
                    let directionValue = entry.direction;
                    let delta          = entry.delta;
                    let date           = entry.date;

                    let elapsed = Math.floor((Date.now() - date) / 1000);

                    let arrow = this._fromDirectionToArrowCharacter(directionValue);
                    let text  = `${glucoseValue} ${arrow}`;

                    if (elapsed >= 600) {
                        this.buttonText.style_class = "expired-data";
                        this._notifyExpiredData(elapsed);
                    } else {
                        this.buttonText.style_class = "fresh-data";
                    }

                    if (
                        true === this.alerts.urgentHigh.enabled &&
                        glucoseValue >= this.alerts.urgentHigh.value
                    ) {
                        this.buttonText.style_class = "urgent-high-glucose";
                        this._notifyGlucose("urgentHightGlucoseNotification", glucoseValue);
                    } else if (
                        true === this.alerts.high.enabled &&
                        glucoseValue >= this.alerts.high.value
                    ) {
                        this.buttonText.style_class = "high-glucose";
                        this._notifyGlucose("highGlucoseNotification", glucoseValue);
                    } else if (
                        true === this.alerts.low.enabled &&
                        glucoseValue >= this.alerts.low.value
                    ) {
                        this.buttonText.style_class = "low-glucose";
                        this._notifyGlucose("lowGlucoseNotification", glucoseValue);
                    } else if (
                        true === this.alerts.urgentLow.enabled &&
                        glucoseValue >= this.alerts.urgentLow.value
                    ) {
                        this.buttonText.style_class = "urgent-low-glucose";
                        this._notifyGlucose("urgentLowGlucoseNotification", glucoseValue);
                    } else if (glucoseValue === 111) {
                        this._notifyGlucose("prizeGlucoseNotification", glucoseValue);
                        this.buttonText.style_class = "fresh-data";
                    } else {
                        this.buttonText.style_class = "fresh-data";
                    }

                    if (true === this.alerts.glucoseVariability.enabled) {
                        if (glucoseValue >= this.alerts.raisingGlucose.value) {
                            this._notifyVariability("raisingUpGlucoseNotification", delta);
                        } else if (glucoseValue <= this.alerts.fallingGlucose.value) {
                            this._notifyVariability("fallingDownGlucoseNotification", delta);
                        }
                    }

                    this.buttonText.set_text(text);
                })
            );
        },
        _notifyGlucose: function (type, glucoseValue) {
            this._notify(
                type,
                messages[type].title,
                messages[type].description.replace("{glucose}", glucoseValue),
                2
            );
        },
        _notifyExpiredData: function (elapsedSeconds) {
            this._notify(
                "expiredDataNotification",
                messages.expiredDataNotification.title,
                messages.expiredDataNotification.description.replace(
                    "{elapsed}",
                    elapsedSeconds
                ),
                2
            );
        },
        _notifyVariability: function (type, delta) {
            this._notify(
                type,
                messages[type].title,
                messages[type].description.replace(
                    "{delta}",
                    Math.abs(delta)
                ),
                2
            );
        },
        _notify: function (notificationName, title, description, urgency) {
            const notificationParams = {
                gicon: new Gio.ThemedIcon({name: "nightscout-icon"}),
            };

            if (null === this.source) {
                this._buildAndAttachSource();
            }

            let notification = this.notifications[notificationName];

            if (null !== notification) {
                notification.update(title, description, notificationParams);
                return;
            }

            notification = this.notifications[
                notificationName
                ] = new MessageTray.Notification(
                this.source,
                title,
                description,
                notificationParams
            );

            notification.connect("destroy", () => {
                print("Notification destroyed " + notification.description);
                this.notifications[notificationName] = null;
            });

            notification.setUrgency(urgency);

            this.source.notify(notification);
        },
        _fromDirectionToArrowCharacter: (directionValue) => {
            switch (directionValue) {
                case "DoubleDown":
                    return "⇊";
                case "DoubleUp":
                    return "⇈";
                case "Flat":
                    return "→";
                case "FortyFiveDown":
                    return "↘";
                case "FortyFiveUp":
                    return "↗";
                case "SingleDown":
                    return "↓";
                case "SingleUp":
                    return "↑";
                case "TripleDown":
                    return "⇊";
                case "TripleUp":
                    return "⇈";
                default:
                    return "";
            }
        },
        _loadData: function () {
            this._checkUpdates();
        },
    }
);

Gettext.textdomain("nightscout@fnandot.github.io");
Gettext.bindtextdomain("nightscout@fnandot.github.io", ExtensionUtils.getCurrentExtension().dir.get_child("locale").get_path());

const trans = Gettext.gettext;

trans("hola")

let extension;

function init() {
}

function enable() {
    extension = new Nightscout();
    Main.panel.addToStatusArea("nightscout", extension);
}

function disable() {
    extension.destroy();
}
