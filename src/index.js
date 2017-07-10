// Module must be started with environment variables
//
//  accesskey="api.ai client access key"
//  slackkey="slack bot key"
//

'use strict';

const Botkit = require('botkit');

const apiai = require('apiai');
const uuid = require('node-uuid');

const http = require('http');

const Entities = require('html-entities').XmlEntities;
const decoder = new Entities();

const apiAiAccessToken = process.env.accesstoken;
const slackBotKey = process.env.slackkey;

const devConfig = process.env.DEVELOPMENT_CONFIG == 'true';

const apiaiOptions = {};
if (devConfig) {
    apiaiOptions.hostname = process.env.DEVELOPMENT_HOST;
    apiaiOptions.path = "/api/query";
}

const apiAiService = apiai(apiAiAccessToken, apiaiOptions);

const sessions = new Map();

const controller = Botkit.slackbot({
    debug: false
    //include "log: false" to disable logging
});

const FIVE_SECONDS = 5000;

var bot = controller.spawn({
    token: slackBotKey
}).startRTM();

function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false;
    }

    if (!obj) {
        return false;
    }

    return obj != null;
}

function messageIsFromThisBot(message) {
    return message.user == bot.identity.id;
}

function messageIsDirectMention(message) {
    return message.text.indexOf("<@U") == 0 && message.text.indexOf(bot.identity.id) == -1;
}

function getIntentFromResponse(response) {
    return response && response.result && response.result.metadata && response.result.metadata.intentName;
}

function getResolvedQueryFromResponse(response) {
    return response && response.result && response.result.resolvedQuery;
}

controller.hears(['.*'], ['direct_message', 'direct_mention', 'mention', 'ambient', 'bot_message'], (bot, message) => {
    try {
        if (message.type != 'message') {
            console.log(`(message=${JSON.stringify(message)}): skipping incorrect message type ${message.type}`);
            return;
        }

        if (messageIsFromThisBot(message)) {
            return;
        }

        if (messageIsDirectMention(message)) {
            return;
        }

        let requestText = decoder.decode(message.text);
        requestText = requestText.replace("’", "'");

        let channel = message.channel;
        let messageType = message.event;
        let botId = '<@' + bot.identity.id + '>';
        let userId = message.user;

        console.log(`(message=${JSON.stringify(message)}): processing Slack message`);
        console.log(`(requestText=${requestText}): processing request text`);

        if (requestText.indexOf(botId) > -1) {
            requestText = requestText.replace(botId, '');
        }

        if (!sessions.has(channel)) {
            sessions.set(channel, { uuid: uuid.v1(), companies: new Set() });
        }

        const session = sessions.get(channel);

        let request = apiAiService.textRequest(requestText,
            {
                sessionId: session.uuid,
                contexts: [
                    {
                        name: "generic",
                        parameters: {
                            slack_user_id: userId,
                            slack_channel: channel
                        }
                    }
                ]
            });

        request.on('response', (response) => {
            console.log(response);

            if (isDefined(response.result)) {
                reply(bot, message, response);

            }
        });

        request.on('error', (error) => console.error(error));
        request.end();
    } catch (err) {
        console.error(err);
    }
});

function reply(bot, message, response) {
    const intent = getIntentFromResponse(response);
    const session = sessions.get(message.channel);

    const handlerFunction = RESPONSE_HANDLERS[intent];
    if (!handlerFunction) {
        console.info(`(intent=${intent}): no handler found for intent. ignoring message and not responding`);
        return;
    }

    bot.startTyping(message);

    handlerFunction(session, message, response);
}

const RESPONSE_HANDLERS = {
    'say-company': sayCompanyIntentResponseHandler
}

function sayCompanyIntentResponseHandler(session, message, response) {
    if (session.hasSharedCompanies) {
        console.info('session has already handled say company intent');
        return;
    }

    session.hasSharedCompanies = true;

    const responseText = response.result.fulfillment.speech;
    const companies = response.result.parameters.company.map((companyName) => {
        session.companies.add({ name: companyName });
    });
    const originalNumberOfCompanies = session.companies.size;

    setTimeout(function () {

        const newNumberOfCompanies = session.companies.size;

        if (originalNumberOfCompanies === newNumberOfCompanies) {
            bot.reply(message, responseText, (err, resp) => {
                if (err) {
                    console.error(err);
                }
            });

        }

    }, FIVE_SECONDS);

}

//Create a server to prevent Heroku kills the bot
const server = http.createServer((req, res) => res.end());

//Lets start our server
server.listen((process.env.PORT || 5000), () => console.log("Listening for chats"));
