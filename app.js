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
    PRIORITY: 3,
  },
  {
    NEW: 'prioridade:media',
    OLD: ['sup:frequencia:raramente', 'sup:gravidade:não consegue contornar'],
    PRIORITY: 2,
  },
  {
    NEW: 'prioridade:media',
    OLD: ['sup:frequencia:ocasionalmente', 'sup:gravidade:existem alternativas'],
    PRIORITY: 2,
  },
  {
    NEW: 'prioridade:bloqueante',
    OLD: ['sup:frequencia:sempre', 'sup:gravidade:não consegue contornar'],
    PRIORITY: 1,
  },
  {
    NEW: 'prioridade:bloqueante',
    OLD: ['sup:acao imediata'],
    PRIORITY: 1,
  },
  {
    NEW: 'prioridade:critico',
    OLD: ['sup:gravidade:não consegue contornar'],
    PRIORITY: 0,
  },
  {
    NEW: 'prioridade:critico',
    OLD: ['sup:frequencia:ocasionalmente', 'sup:gravidade:não consegue contornar'],
    PRIORITY: 0,
  },
];

const github = new GitHubApi({
  debug: false,
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
      // Recursive call
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

function persist(issues, file = 'issues.json') {
  return new Promise((resolve, reject) => {
    fs.writeFile(file, JSON.stringify(issues, null, 2), 'utf8', (err) => {
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

      const labelsFound = _.filter(LABELS, (lbl) => {
        return _.every(lbl.OLD, (name) => {
          return _.includes(labelHistory, name);
        });
      });

      const label = _.minBy(labelsFound, 'PRIORITY');

      if (!labelsFound.length) return;
      modifyable.push({
        number: issue.number,
        label,
      });
    }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  return modifyable;
}

async function addIssueLabels(issue) {
  debug('updating issue: ', issue.number, ' with labels: ', issue.label.NEW);
  if (process.env.NODE_ENV === 'production') {
    return github.issues.addLabels({
      owner: 'involvestecnologia',
      repo: 'agilepromoterissues',
      number: issue.number,
      labels: [issue.label.NEW],
    });
  }
}

async function removeIssueLabels(issue) {
  const labels = _.map(issue.labels, 'NEW');
  debug('updating issue: ', issue.number, ' with labels: ', labels);
  if (process.env.NODE_ENV === 'production') {
    const promises = _.map(labels, label => new Promise((resolve) => {
      github.issues.removeLabel({
        owner: 'involvestecnologia',
        repo: 'agilepromoterissues',
        number: issue.number,
        name: label,
      }).finally(resolve);
    }));

    await Promise.all(promises);
  }
}

function addLabels(issues) {
  debug('updating issues labels');
  return new Promise((resolve, reject) => {
    async.eachSeries(issues, addIssueLabels, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function removeLabels(issues) {
  debug('updating issues labels');
  return new Promise((resolve, reject) => {
    async.eachSeries(issues, removeIssueLabels, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function execute() {
  if (!fileExists('issues.json')) {
    debug('loading from github api since issues.json doesn\'t exist');
    await findIssues();
  }
  debug('loading from issues.json file');

  const issues = JSON.parse(fs.readFileSync('issues.json'));
  const results = await buildIssuesList(issues);
  await addLabels(results);

  debug('labels updated');
}

execute()
  .then(() => debug('execution finished'))
  .catch(console.error);
