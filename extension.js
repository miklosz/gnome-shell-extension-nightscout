const St = imports.gi.St;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Soup = imports.gi.Soup;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const PanelMenu = imports.ui.panelMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;

const messages = {
    prizeGlucoseNotification: {
        title: 'Prize! You got {glucose}!',
        description: 'Your glucose is now {glucose} mg/dl, congratulations!'
    },
    highGlucoseNotification: {
        title: 'Your blood glucose is high!',
        description: 'Your glucose is now {glucose} mg/dl.'
    },
    lowGlucoseNotification: {
        title: 'Your blood glucose is low!',
        description: 'Your glucose is now {glucose} mg/dl.'
    },
    expiredDataNotification: {
        title: 'You have missing readings!',
        description: 'There is no new readings since {elapsed} seconds ago.'
    },
    fallingDownGlucoseNotification: {
        title: 'Your blood glucose is falling down fastly!',
        description: 'Your glucose is falling down at ↓{delta} mg/dl since last reading.'
    },
    raisingUpGlucoseNotification: {
        title: 'Your blood glucose is raising up fastly!',
        description: 'Your glucose is raising up at ↑{delta} mg/dl since last reading.'
    },
};

const Nightscout = new Lang.Class({
        Name: 'Nightscout',
        Extends: PanelMenu.Button,
        source: null,
        settings: null,
        updateInterval: 30,
        httpSession: null,
        notifications: {
            prizeGlucoseNotification: null,
            highGlucoseNotification: null,
            lowGlucoseNotification: null,
            expiredDataNotification: null,
            fallingDownGlucoseNotification: null,
            raisingUpGlucoseNotification: null,
        },
        _init: function () {

            this.parent(0.0, "Nightscout", false);
            this.buttonText = new St.Label({
                text: "Loading...",
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'fresh-data'
            });

            this.settings = this._getSettings();

            this.httpSession = new Soup.Session();
            this.actor.add_actor(this.buttonText);

            this._buildAndAttachSource();

            this._initIcons();
            this._refresh();
        },

        _getSettings: function () {
            let extension = ExtensionUtils.getCurrentExtension();
            let schema = extension.metadata['settings-schema'];

            const GioSSS = Gio.SettingsSchemaSource;
            let schemaDir = extension.dir.get_child('schemas');
            let schemaSource;
            if (schemaDir.query_exists(null))
                schemaSource = GioSSS.new_from_directory(schemaDir.get_path(),
                    GioSSS.get_default(),
                    false);
            else
                schemaSource = GioSSS.get_default();

            let schemaObj = schemaSource.lookup(schema, true);
            if (!schemaObj)
                throw new Error('Schema ' + schema + ' could not be found for extension '
                    + extension.metadata.uuid + '. Please check your installation.');

            return new Gio.Settings({settings_schema: schemaObj});
        },

        _refresh: function () {
            this._loadData();
            this._removeTimeout();
            this._timeout = Mainloop.timeout_add_seconds(this.updateInterval, Lang.bind(this, this._refresh));
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
            let theme = Gtk.IconTheme.get_default();
            let iconDir = extension.dir.get_child('icons');
            if (iconDir.query_exists(null)) {
                theme.append_search_path(iconDir.get_path());
            }
        },

        _buildAndAttachSource: function () {
            this.source = new MessageTray.SystemNotificationSource();
            this.source.connect('destroy', () => this.source = null);
            Main.messageTray.add(this.source);
        },

        _checkUpdates: function () {
            const nightscoutUrl = this.settings.get_string('url');
            const authKey = this.settings.get_string('authkey');
            const fullUrl = `${nightscoutUrl}/api/v1/entries.json?count=1&token=${authKey}`;

            let message =  Soup.Message.new('GET',fullUrl);

            this.httpSession.queue_message(message, Lang.bind(this,
                function (_httpSession, message) {

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

                    let glucoseValue = entry.sgv;
                    let directionValue = entry.direction;
                    let delta = entry.delta;
                    let date = entry.date;

                    let elapsed = Math.floor((Date.now() - date) / 1000);

                    let arrow = this._fromNameToArrowCharacter(directionValue);
                    let text = `${glucoseValue} ${arrow}`;

                    if (elapsed >= 600) {
                        this.buttonText.style_class = 'expired-data';
                        this._notifyExpiredData(elapsed);
                    } else {
                        this.buttonText.style_class = 'fresh-data';
                    }

                    if (glucoseValue < 80) {
                        this.buttonText.style_class = 'low-glucose';
                        this._notifyLowGlucose(glucoseValue);
                    } else if (glucoseValue > 180) {
                        this.buttonText.style_class = 'high-glucose';
                        this._notifyHighGlucose(glucoseValue);
                    } else if (glucoseValue === 111) {
                        this._notifyPrizeGlucose(glucoseValue);
                        this.buttonText.style_class = 'fresh-data';
                    } else {
                        this.buttonText.style_class = 'fresh-data';
                    }

                    if (delta >= 10) {
                        this._notifyRaisingUpGlucose(delta);
                    } else if (delta <= -10) {
                        this.notifyFallingDownGlucose(delta);
                    }

                    this.buttonText.set_text(text);
                })
            );
        },
        _notifyLowGlucose: function (glucoseValue) {
            this._notify(
                'lowGlucoseNotification',
                messages.lowGlucoseNotification.title,
                messages.lowGlucoseNotification.description.replace('{glucose}', glucoseValue),
                2
            );
        },
        _notifyHighGlucose: function (glucoseValue) {
            this._notify(
                'highGlucoseNotification',
                messages.highGlucoseNotification.title,
                messages.highGlucoseNotification.description.replace('{glucose}', glucoseValue),
                2
            );
        },
        _notifyExpiredData: function (elapsedSeconds) {
            this._notify(
                'expiredDataNotification',
                messages.expiredDataNotification.title,
                messages.expiredDataNotification.description.replace('{elapsed}', elapsedSeconds),
                2
            );
        },
        notifyFallingDownGlucose: function (delta) {
            this._notify(
                'fallingDownGlucoseNotification',
                messages.fallingDownGlucoseNotification.title,
                messages.fallingDownGlucoseNotification.description.replace('{delta}', Math.abs(delta)),
                2
            );
        },
        _notifyRaisingUpGlucose: function (delta) {
            this._notify(
                'raisingUpGlucoseNotification',
                messages.raisingUpGlucoseNotification.title,
                messages.raisingUpGlucoseNotification.description.replace('{delta}', Math.abs(delta)),
                2
            );
        },
        _notifyPrizeGlucose: function (glucoseValue) {
            this._notify(
                'prizeGlucoseNotification',
                messages.prizeGlucoseNotification.title.replace('{glucose}', glucoseValue),
                messages.prizeGlucoseNotification.description.replace('{glucose}', glucoseValue),
                2
            );
        },
        _notify: function (notificationName, title, description, urgency) {

            const notificationParams = {
                gicon: new Gio.ThemedIcon({name: 'nightscout-icon'})
            };

            if (null === this.source) {
                this._buildAndAttachSource();
            }

            let notification = this.notifications[notificationName];

            if (null !== notification) {
                notification.update(
                    title,
                    description,
                    notificationParams
                );
                return;
            }

            notification = this.notifications[notificationName] = new MessageTray.Notification(
                this.source,
                title,
                description,
                notificationParams
            );

            notification.connect('destroy', () => {
                print("Notification destroyed " + notification.description);
                this.notifications[notificationName] = null
            });

            notification.setUrgency(urgency);

            this.source.notify(notification);
        },
        _fromNameToArrowCharacter: (directionValue) => {
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
    })
;

let extension;

function init() {

}

function enable() {
    extension = new Nightscout;
    Main.panel.addToStatusArea('nightscout', extension);
}

function disable() {
    extension.destroy();
}
