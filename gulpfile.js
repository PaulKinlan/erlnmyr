var gulp = require('gulp');
var parseArgs = require('minimist');
var fs = require('fs');
var mocha = require('gulp-mocha');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var http = require('http');

var TreeBuilder = require('./lib/tree-builder');
var HTMLWriter = require('./lib/html-writer');
var JSWriter = require('./lib/js-writer');
var StatsWriter = require('./lib/stats-writer');
var StyleFilter = require('./lib/style-filter');
var StyleMinimizationFilter = require('./lib/style-minimization-filter');
var StyleTokenizerFilter = require('./lib/style-tokenizer-filter');
var SchemaBasedFabricator = require('./lib/schema-based-fabricator');
var NukeIFrameFilter = require('./lib/nuke-iframe-filter');
var ParseExperiment = require('./lib/parse-experiment');

var options = parseArgs(process.argv.slice(2));

function writeFile(output, data, cb) {
  fs.writeFile(output, data, function(err) {
    if (err)
      throw err;
    console.log('written results into \"' + output + '\".');
    cb();
  });
}

function readJSONFile(filename, cb) {
  fs.readFile(filename, 'utf8', function(err, data) {
    if (err)
      throw err;
    var data = JSON.parse(data);
    cb(data);
  });
}

function readFile(filename, cb) {
  fs.readFile(filename, 'utf8', function(err, data) {
    if (err)
      throw err;
    cb(data);
  });
}

/*
 * Pipeline Stages
 *
 * Each stage accepts a data object and a callback, and is responsible for
 * calling the callback with the result of processing the data.
 */

function JSONReader(filename) {
  return function(_, cb) { readJSONFile(filename, cb); };
}

function fileReader(filename) {
  return function(_, cb) { readFile(filename, cb); };
}

function nullFilter() {
  return function(data, cb) { cb(data); }
}

function filter(FilterType) {
  return treeBuilderWriter(FilterType);
}

function fabricator(FabType) {
  return function(data, cb) {
    var fab = new FabType(data);
    cb(fab.fabricate());
  }
}

function treeBuilderWriter(WriterType) {
  return function(data, cb) {
    var writer = new WriterType();
    var builder = new TreeBuilder(writer);
    builder.build(data);
    builder.write(writer);
    cb(writer.getHTML());
  }
};

function fileOutput(filename) {
  return function(data, cb) { writeFile(filename, data, cb); };
}

function consoleOutput() {
  return function(data, cb) { console.log(data); cb(); };
}

// update PYTHONPATH for all telemetry invocations
if (options.chromium !== undefined)
  process.env.PYTHONPATH += ':' + options.chromium + '/tools/telemetry';

function telemetryTask(pyScript, pyArgs) {
  return function(unused, cb) {
    var result = "";
    var task = spawn('python', ['telemetry/' + pyScript].concat(pyArgs));
    task.stdout.on('data', function(data) { result += data; });
    task.stderr.on('data', function(data) { console.log('stderr: ' + data); });
    task.on('close', function(code) { cb(result); });
  };
}

function telemetrySave(browser, url) {
  return function(unused, cb) {
    telemetryTask('save.py', ['--browser='+browser, '--', url])(unused, function(data) { cb(JSON.parse(data)); });
  };
}

function startADBForwarding(then) {
  exec(options.adb + ' reverse tcp:8000 tcp:8000', then);
}

function stopADBForwarding(then) {
  exec(options.adb + ' reverse --remove tcp:8000', then);
}

function startServing(data) {
  return http.createServer(function(req, res) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(data);
  }).listen(8000, '127.0.0.1');
}

function stopServing(server) {
  server.close();
}

// perform perf testing of the provided url
function telemetryPerf(browser, url) {
  return telemetryTask('perf.py', ['--browser='+browser, '--', url]);
}

// start a local server and perf test pipeline-provided data
function simplePerfer() {
  var telemetryStep = telemetryPerf(options.perfBrowser, 'http://localhost:8000');
  return function(data, cb) {
    startADBForwarding(function() {
      var server = startServing(data);
      telemetryStep(undefined, function(result) {
        stopServing(server);
        stopADBForwarding(function() {
          cb(result);
        });
      });
    });
  };
}

gulp.task('test', function() {
  return gulp.src('tests/*.js', {read: false})
      .pipe(mocha({
        ui: 'bdd',
        ignoreLeaks: true,
        reporter: 'nyan'
    }));
});

function parseExperiment() {
  return function(data, cb) { cb(new ParseExperiment().parse(data)); };
}

/*
 * Constructing a pipeline
 *
 * Sorry for potato quality.
 */
function processStages(stages, cb) {
  for (var i = stages.length - 1; i >= 0; i--) {
    cb = (function(i, cb) { return function(data) { stages[i](data, cb); } })(i, cb);
  }
  cb(null);
};

function buildTask(name, stages) {
  gulp.task(name, function(cb) {
    processStages(stages, cb);
  });
};

/*
 * Some example pipelines.
 */
buildTask('html', [JSONReader(options.file), treeBuilderWriter(HTMLWriter), fileOutput('result.html.html')]);
buildTask('js', [JSONReader(options.file), treeBuilderWriter(JSWriter), fileOutput('result.js.html')]);
buildTask('stats', [JSONReader(options.file), treeBuilderWriter(StatsWriter), consoleOutput()]);
buildTask('compactComputedStyle', [JSONReader(options.file), filter(StyleFilter), fileOutput(options.file + '.filter')]);
buildTask('extractStyle', [JSONReader(options.file), filter(StyleMinimizationFilter), fileOutput(options.file + '.filter')]);
buildTask('generate', [JSONReader(options.file), fabricator(SchemaBasedFabricator), fileOutput(options.file + '.gen')]);
buildTask('tokenStyles', [JSONReader(options.file), filter(StyleTokenizerFilter), fileOutput(options.file + '.filter')]);
buildTask('nukeIFrame', [JSONReader(options.file), filter(NukeIFrameFilter), fileOutput(options.file + '.filter')]);
buildTask('runExperiment', [fileReader(options.file), parseExperiment(), runExperiment, consoleOutput()]);
buildTask('get', [telemetrySave(options.saveBrowser, options.url), fileOutput('result.json')]);
buildTask('perf', [telemetryPerf(options.perfBrowser, options.url), fileOutput('trace.json')]);
buildTask('endToEnd', [telemetrySave(options.saveBrowser, options.url), treeBuilderWriter(HTMLWriter), simplePerfer(), fileOutput('trace.json')]);

/*
 * experiments
 */

function collectInputs(inputSpec) {
  if (inputSpec.substring(0, 7) == 'http://')
    return [inputSpec];
  var re = new RegExp('^' + inputSpec + '$');
  var files = fs.readdirSync('.');
  return files.filter(re.exec.bind(re));
}

function readerForInput(name) {
  if (name.substring(0, 7) == 'http://')
    return telemetrySave(options.saveBrowser, name)
  return JSONReader(name);
}

function outputForInput(inputSpec, input, output) {
  var re = new RegExp(inputSpec);
  return input.replace(re, output);
}

function appendEdges(experiment, stages, edges) {
  var newList = [];
  for (var j = 0; j < edges.length; j++) {
    var newStages = stages.concat(edges[j].stages);
    if (edges[j].output in experiment.tree)
      newList = newList.concat(appendEdges(experiment, newStages, experiment.tree[edges[j].output]));
    else
      newList.push({stages: newStages, output: edges[j].output});
  }
  return newList;
}

function experimentTask(name, experiment) {
  gulp.task(name, function(cb) { runExperiment(experiment, cb); });
}

function stageFor(stageName) {
  if (stageName[0].toLowerCase() == stageName[0])
    return eval(stageName)();
  // FIXME: This relies on the fact that filters and writers are both the same thing
  // right now (i.e. filter and treeBuilderWriter are the same function).
  // This could well become a problem in the future.
  // Also, eval: ew. If there was a local var dict I could look up the constructor name directly.
  return filter(eval(stageName));
}

function runExperiment(experiment, cb) {
  var pipelines = [];
  for (var i = 0; i < experiment.inputs.length; i++) {
    var inputs = collectInputs(experiment.inputs[i]);
    var edges = experiment.tree[experiment.inputs[i]];
    var stagesList = [];
    stagesList = appendEdges(experiment, stagesList, edges);
    for (var j = 0; j < inputs.length; j++) {
      for (var k = 0; k < stagesList.length; k++) {
        var pl = [readerForInput(inputs[j])].concat(stagesList[k].stages.map(function(a) { return stageFor(a); }));
        pl.push(fileOutput(outputForInput(experiment.inputs[i], inputs[j], stagesList[k].output)));
        pipelines.push(pl);
      }
    }
  }
  for (var i = 0; i < pipelines.length; i++) {
    var cb = (function(i, cb) { return function() { processStages(pipelines[i], cb); } })(i, cb);
  }
  return cb(null);
}

