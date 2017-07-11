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

var rp = require('request-promise-native');
const SLACK_OAUTH = {
    CLIENT_ID: process.env.SLACK_OAUTH_CLIENT_ID,
    ACCESS_TOKEN: process.env.SLACK_OAUTH_ACCESS_TOKEN
};
const GETHUMAN_REPS_USER_GROUP = 'S5ZQGD388';

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
const THREE_SECONDS = 3000;

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
        let botId = '<@' + bot.identity.id + '>';

        console.log(`(message=${JSON.stringify(message)}): processing Slack message`);
        console.log(`(requestText=${requestText}): processing request text`);

        if (requestText.indexOf(botId) > -1) {
            requestText = requestText.replace(botId, '');
        }

        if (!sessions.has(channel)) {
            sessions.set(channel, { uuid: uuid.v1(), companies: new Set() });
        }

        const session = sessions.get(channel);

        const visitorMessageFromChatlioWelcome = messageIsChatlioWelcome(requestText);
        console.log('Session metadata: ', session);

        if (visitorMessageFromChatlioWelcome) {
            askApiAi(message, visitorMessageFromChatlioWelcome)
            return;
        }

        askApiAi(message, requestText);


    } catch (err) {
        console.error(err);
    }
});

function messageIsChatlioWelcome(messageText) {
    var getVisitorsMessagePattern = /Visitor: _(.*)_/;
    var parsedMessage = getVisitorsMessagePattern.exec(messageText);

    return parsedMessage && parsedMessage.length > 1 && parsedMessage[1].trim();
}

function askApiAi(slackMessageSource, requestText) {
    let { userId, channel } = slackMessageSource;

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
            reply(slackMessageSource, response);
        }
    });

    request.on('error', (error) => console.error(error));
    request.end();
}

function reply(message, response) {
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

const SAY_COMPANY_INTENT = 'say-company';
const ESTIMATE_BILL_INTENT = 'estimate-bill';

const RESPONSE_HANDLERS = {
    [SAY_COMPANY_INTENT]: sayCompanyIntentResponseHandler,
    [ESTIMATE_BILL_INTENT]: estimateBillResponseHandler
}

function sayCompanyIntentResponseHandler(session, message, response) {
    if (session.hasSharedCompanies) {
        console.info(`(${SAY_COMPANY_INTENT}): session has already handled this intent`);
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
            doReply(message, responseText);
        }

    }, FIVE_SECONDS);

}

function estimateBillResponseHandler(session, message, response) {
    if (!session.hasSharedCompanies) {
        console.info(`(${ESTIMATE_BILL_INTENT}): session needs to answer which companies they pay before estimating price`);
        return;
    }

    if (session.hasEstimatedBill) {
        console.info(`(${ESTIMATE_BILL_INTENT}): session has already handled this intent`);
        return;
    }

    session.hasEstimatedBill = true;

    const companyName = chooseRandomCompanyName(session.companies);
    const lowerSavingsEstimate = 20;
    const upperSavingsEstimate = lowerSavingsEstimate + (10 * session.companies.size);
    const responseText = `Based on all of your bills (especially with ${companyName}), I think we can save you around $${lowerSavingsEstimate}-$${upperSavingsEstimate}, or at least $${lowerSavingsEstimate * 12} a year. Can I explain how?`
    setTimeout(function () {
        inviteGetHumanRepsToRoom(message);
        doReply(message, responseText);
    }, THREE_SECONDS);
}

function chooseRandomCompanyName(companies) {
    const companyNames = [...companies.values()];
    console.log('companies name: ', companyNames);
    const randomIndex = Math.floor(Math.random() * companyNames.length);
    const companyName = companyNames[randomIndex].name;
    return companyName.charAt(0).toUpperCase() + companyName.substring(1, companyName.length);
}

function inviteGetHumanRepsToRoom(message) {
    inviteUserGroupToChannel(GETHUMAN_REPS_USER_GROUP, message.channel);
}

function inviteUserGroupToChannel(groupId, channelId) {
    return getSlackUserIdsForUserGroup(groupId).then((userIds) => {
        return inviteUserIdsToChannel(userIds, channelId);
    });
}

function getSlackUserIdsForUserGroup(groupId) {
    return rp.post({
        url: 'https://slack.com/api/usergroups.users.list',
        formData: {
            token: SLACK_OAUTH.ACCESS_TOKEN,
            usergroup: groupId
        },
        json: true
    }).then((parsedBody) => {
        return parsedBody.users;
    });
}

function inviteUserIdsToChannel(userIds, channelId) {
    let inviteUsersToChannelRequests = [];

    userIds.forEach((userId) => {
        inviteUsersToChannelRequests.push(inviteSlackUserIdToChannel(userId, channelId));
    });

    return Promise.all(inviteUsersToChannelRequests);
}

function inviteSlackUserIdToChannel(userId, channelId) {
    console.log(`inviting user ${userId} to channel ${channelId}`);

    return rp.post({
        url: 'https://slack.com/api/channels.invite',
        formData: {
            token: SLACK_OAUTH.ACCESS_TOKEN,
            channel: channelId,
            user: userId
        },
        json: true
    }).then((parsedBody) => {
        return parsedBody.ok;
    });


}

function doReply(message, responseText) {
    bot.reply(message, responseText, (err, resp) => {
        if (err) {
            console.error(err);
        }
    });
}

//Create a server to prevent Heroku kills the bot
const server = http.createServer((req, res) => res.end());

//Lets start our server
server.listen((process.env.PORT || 5000), () => console.log("Listening for chats"));
