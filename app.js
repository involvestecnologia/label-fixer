const debug = require('debug')('label-fixer');
const fs = require('fs');
const Promise = require('bluebird');
const async = require('async');
const _ = require('lodash');
const GitHubApi = require('github');

const LABELS = [
  {
    NEW: 'prioridade:baixa',
    OLD: ['sup:frequencia:raramente', 'sup:gravidade:existem alternativas'],
  },
  {
    NEW: 'prioridade:media',
    OLD: ['sup:frequencia:raramente', 'sup:gravidade:não consegue contornar'],
  },
  {
    NEW: 'prioridade:media',
    OLD: ['sup:frequencia:ocasionalmente', 'sup:gravidade:existem alternativas'],
  },
  {
    NEW: 'prioridade:bloqueante',
    OLD: ['sup:frequencia:sempre', 'sup:gravidade:não consegue contornar'],
  },
  {
    NEW: 'prioridade:bloqueante',
    OLD: ['sup:acao imediata'],
  },
  {
    NEW: 'prioridade:critico',
    OLD: ['sup:gravidade:não consegue contornar'],
  },
  {
    NEW: 'prioridade:critico',
    OLD: ['sup:frequencia:ocasionalmente', 'sup:gravidade:não consegue contornar'],
  },
];

const github = new GitHubApi({
  debug: true,
  Promise,
});

github.authenticate({
  type: 'token',
  token: process.env.token,
});

const fileExists = (file) => {
  try {
    fs.accessSync(file);
  } catch (err) {
    return !(err.code === 'ENOENT');
  }
  return true;
};

async function getClosedIssues() {
  const filtered = [];

  const paginate = async (res) => {
    debug('Loaded issues:', filtered.length);

    const next = await github.getNextPage(res);
    filtered.push(...next.data);

    if (github.hasNextPage(next)) {
      await paginate(next);
    }
  };

  const res = await github.issues.getForRepo({
    owner: 'involvestecnologia',
    repo: 'agilepromoterissues',
    state: 'closed',
  });

  filtered.push(...res.data);

  if (github.hasNextPage(res)) {
    await paginate(res);
  }

  return filtered;
}

async function getIssueTimeline(issue) {
  debug('Loading timeline for issue: ', issue.number);
  const { data } = await github.issues.getEventsTimeline({
    owner: 'involvestecnologia',
    repo: 'agilepromoterissues',
    issue_number: issue.number,
  });

  issue.timeline = data;
}

function getIssuesTimeline(issues) {
  return new Promise((resolve, reject) => {
    async.eachLimit(issues, 10, getIssueTimeline, (err) => {
      if (err) return reject(err);
      resolve(issues);
    });
  });
}

function persist(issues) {
  return new Promise((resolve, reject) => {
    fs.writeFile('issues.json', JSON.stringify(issues, null, 2), 'utf8', (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function findIssues() {
  debug('loading closed issues');
  const issues = await getClosedIssues();
  await getIssuesTimeline(issues);
  await persist(issues);

  return issues;
}

async function buildIssuesList(issues) {
  const modifyable = [];

  await new Promise((resolve, reject) => {
    async.each(issues, async (issue) => {
      const labeleds = {};
      _.each(issue.timeline, (evt) => {
        if (evt.event === 'labeled') {
          labeleds[evt.label.name] = evt.label;
          return;
        }
        if (evt.event === 'unlabeled') {
          delete labeleds[evt.label.name];
        }
      });

      const labelHistory = _(labeleds)
        .toArray()
        .map('name')
        .value();

      const toAddLabels = _.filter(LABELS, (lbl) => {
        return _.every(lbl.OLD, (name) => {
          return _.includes(labelHistory, name);
        });
      });

      if (!toAddLabels.length) return;
      modifyable.push({
        number: issue.number,
        labels: toAddLabels,
      });
    }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  return modifyable;
}

function addIssueLabels(issue) {
  const http = require('https');

  const options = {
    method: 'POST',
    hostname: 'api.github.com',
    port: null,
    path: `/repos/involvestecnologia/agilepromoterissues/issues/${issue.number}/labels`,
    headers: {
      host: 'api.github.com',
      'content-length': '46',
      'content-type': 'application/json; charset=utf-8',
      authorization: 'token 7ebd2974c9b02111853b6ed1943e94e950099f25',
      'user-agent': 'NodeJS HTTP Client',
      accept: 'application/vnd.github.v3+json',
      ca: 'undefined',
      'cache-control': 'no-cache',
    },
  };

  return new Promise((resolve, reject) => {
    const labels = _.map(issue.labels, 'NEW');
    const req = http.request(options, (res) => {
      const hasError = res.statusCode !== 200;

      const chunks = [];

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        (hasError ? reject : resolve)(Buffer.concat(chunks));
      });
    });

    req.on('error', reject);

    req.write(JSON.stringify(labels));
    req.end();
  });
}

function addlabel(issue) {
  const labels = _.map(issue.labels, 'NEW');
  debug('updating issue: ', issue.number, ' with labels: ', labels);
  if (process.env.NODE_ENV === 'production') {
    return addIssueLabels(issue);
  }
  return Promise.resolve();
}

async function addLabels(issues) {
  debug('updating issues labels');
  const success = await addlabel(issue);
}

async function execute() {
  if (!fileExists('issues.json')) {
    debug('loading from github api since issues.json doesn\'t exist');
    await findIssues();
  }
  debug('loading from issues.json file');

  const issues = JSON.parse(fs.readFileSync('issues.json'));
  const toAdd = await buildIssuesList(issues);
  await addLabels(toAdd);

  debug('labels updated');
}

execute()
  .then(() => debug('execution finished'))
  .catch(console.error);
