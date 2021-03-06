/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/nopt/nopt.d.ts" />
/// <reference path="../node_modules/facetjs/build/facetjs.d.ts" />
/// <reference path="../node_modules/facetjs-druid-requester/build/facetjs-druid-requester.d.ts" />
"use strict";

import fs = require('fs');
import path = require("path");
import Q = require('q');
import nopt = require("nopt");
import chronology = require("chronology");

import facet = require("facetjs");
import $ = facet.$;
import Expression = facet.Expression;
import RefExpression = facet.RefExpression;
import ActionsExpression = facet.ActionsExpression;
import DefAction = facet.DefAction;
import Datum = facet.Datum;
import Dataset = facet.Dataset;

import DruidRequester = require('facetjs-druid-requester')
import druidRequesterFactory = DruidRequester.druidRequesterFactory;

var WallTime = chronology.WallTime;
if (!WallTime.rules) {
  var tzData = require("chronology/lib/walltime/walltime-data.js");
  WallTime.init(tzData.rules, tzData.zones);
}

var Duration = chronology.Duration;
var Timezone = chronology.Timezone;

function usage() {
  console.log(`
Usage: facet [options]

Example: facet -h 10.20.30.40 -q "SELECT MAX(__time) AS maxTime FROM twitterstream"

      --help         print this help message
      --version      display the version number
  -v, --verbose      display the queries that are being made
  -h, --host         the host to connect to
  -d, --data-source  use this data source for the query (supersedes FROM clause)
  -i, --interval     add (AND) a __time filter between NOW-INTERVAL and NOW
  -q, --query        the query to run
  -o, --output       specify the output format. Possible values: json (default), csv

  -a, --allow        enable a behaviour that is turned off by default
          eternity     allow queries not filtered on time
          select       allow select queries
`
  )
}

function version(): void {
  var cliPackageFilename = path.join(__dirname, '..', 'package.json');
  try {
    var cliPackage = JSON.parse(fs.readFileSync(cliPackageFilename, 'utf8'));
  } catch (e) {
    console.log("could not read cli package", e.message);
    return;
  }
  console.log(`facet-cli version ${cliPackage.version} [alpha] (facetjs version ${facet.version})`);
}

function getDatasourceName(ex: Expression): string {
  var name: string = null;
  ex.some((ex) => {
    if (ex instanceof ActionsExpression) {
      var operand = ex.operand;
      var firstAction = ex.actions[0];
      if (operand instanceof RefExpression) {
        name = operand.name;
        return true;
      } else if (firstAction instanceof DefAction && firstAction.name === 'data') {
        var firstActionExpression = firstAction.expression;
        if (firstActionExpression instanceof RefExpression) {
          name = firstActionExpression.name;
          return true;
        }
      }
    }
    return null;
  });
  return name;
}

function parseArgs() {
  return nopt(
    {
      "host": String,
      "data-source": String,
      "help": Boolean,
      "query": String,
      "interval": String,
      "version": Boolean,
      "verbose": Boolean,
      "output": String,
      "allow": [String, Array]
    },
    {
      "h": ["--host"],
      "q": ["--query"],
      "v": ["--verbose"],
      "d": ["--data-source"],
      "i": ["--interval"],
      "a": ["--allow"],
      "o": ["--output"]
    },
    process.argv
  );
}

function wrapVerbose(requester: Requester.FacetRequester<any>): Requester.FacetRequester<any> {
  return (request: Requester.DatabaseRequest<any>): Q.Promise<any> => {
    console.log("vvvvvvvvvvvvvvvvvvvvvvvvvv");
    console.log("Sending query:");
    console.log(JSON.stringify(request.query, null, 2));
    console.log("^^^^^^^^^^^^^^^^^^^^^^^^^^");
    var srartTime = Date.now();
    return requester(request)
      .then((data) => {
        console.log("vvvvvvvvvvvvvvvvvvvvvvvvvv");
        console.log(`Got result: (in ${Date.now() - srartTime}ms)`);
        console.log(JSON.stringify(data, null, 2));
        console.log("^^^^^^^^^^^^^^^^^^^^^^^^^^");
        return data;
      });
  }
}

export function run() {
  var parsed = parseArgs();
  if (parsed.argv.original.length === 0 || parsed['help']) return usage();
  if (parsed['version']) return version();

  // Get allow
  var allow: string[] = parsed['allow'] || [];
  for (var i = 0; i < allow.length; i++) {
    if (!(allow[i] === 'eternity' || allow[i] === 'select')) {
      console.log("Unexpected allow", allow[i]);
      return;
    }
  }

  // Get output
  var output: string = parsed['output'] || 'json';
  if (output !== 'json') {
    console.log("only json output is supported for now");
    return;
  }

  // Get host
  var host: string = parsed['host'];
  if (!host) {
    console.log("must have host (for now)");
    return;
  }

  // Get SQL
  var query: string = parsed['query'];
  var expression: Expression = null;
  if (query) {
    query = query.trim();
    if (/^SELECT/i.test(query)) {
      try {
        expression = Expression.parseSQL(query);
      } catch (e) {
        console.log("Could not parse query as SQL:", e.message);
        return;
      }

    } else if (query[0] === '$') {
      try {
        expression = Expression.parse(query);
      } catch (e) {
        console.log("Could not parse query as facet:", e.message);
        return;
      }

    } else if (query[0] === '{') {
      try {
        expression = Expression.fromJS(JSON.parse(query));
      } catch (e) {
        console.log("Could not parse query as facet:", e.message);
        return;
      }

    } else {
      console.log("Could not determine query type (query should start with 'SELECT', '$', or '{')");
      return;
    }
  } else {
    console.log("no query found please use --query (-q) flag");
    return;
  }

  var dataSource = getDatasourceName(expression);
  if (!dataSource) {
    console.log("must have data source");
    return;
  }

  var druidRequester = druidRequesterFactory({
    host: host,
    timeout: 30000
  });

  var requester: Requester.FacetRequester<any>;
  if (parsed['verbose']) {
    requester = wrapVerbose(druidRequester);
  } else {
    requester = druidRequester;
  }

  var timeAttribute = '__time';

  var filter: Expression = null;
  var intervalString: string = parsed['interval'];
  if (intervalString) {
    try {
      var interval = Duration.fromJS(intervalString);
    } catch (e) {
      console.log("Could not parse interval", intervalString);
      console.log(e.message);
      return;
    }

    var now = chronology.minute.floor(new Date(), Timezone.UTC());
    filter = $(timeAttribute).in({ start: interval.move(now, Timezone.UTC(), -1), end: now })
  }

  var dataset = Dataset.fromJS({
    source: 'druid',
    dataSource: dataSource,
    timeAttribute: timeAttribute,
    allowEternity: allow.indexOf('eternity') !== -1,
    allowSelectQueries: allow.indexOf('select') !== -1,
    filter: filter,
    requester: requester
  });

  var context: Datum = {};
  context[dataSource] = dataset;

  expression.compute(context)
    .then(
      (data: any) => {
        console.log(JSON.stringify(data, null, 2));
      },
      (err: Error) => {
        console.log("There was an error getting the data:", err.message);
      }
    ).done()
}
