const fs = require('fs')
const path = require('path')
const express = require('express')
const Mincer = require('mincer')
const coffee = require('coffeescript')
const morgan = require('morgan')
const errorHandler = require('errorhandler')
const compression = require('compression')
const bodyParser = require('body-parser')
const serveStatic = require('serve-static')
const methodOverride = require('method-override')
const InMemoryHistory = require('./inMemoryHistory')
const Promise = require('bluebird')
const router = require("../../../routes/index.js")

Mincer.Template.libs.coffee = coffee

module.exports.logger = logger = require('./logger')
module.exports.Dashing = function Dashing() {
  let dashing = {};
  dashing.root = path.resolve(__dirname, '../../..')
  dashing.NODE_ENV = process.env.NODE_ENV || 'development'

  dashing.view_engine = process.env.VIEW_ENGINE || 'pug'

  dashing.mincer = {}
  dashing.mincer.environment = new Mincer.Environment()
  dashing.mincer.assets_prefix = '/assets'
  dashing.mincer.environment.appendPath('assets')
  dashing.mincer.environment.appendPath('widgets')
  dashing.mincer.environment.appendPath(path.resolve(__dirname, '../javascripts'))

  dashing.public_folder = dashing.root + '/public'
  dashing.views = dashing.root + '/dashboards'
  dashing.settings = dashing.root + '/settings'
  dashing.default_dashboard = null
  dashing.port = (process.env.PORT || 3030)
  dashing.force_close_event_socket = false

  dashing.protected = function(req, res, next) {
    next()
  }

  dashing._protected = function(req, res, next) {
    dashing.protected(req, res, next)
  }

  let expressLoggerOptions = {
    format: 'dev',
    stream: {
      write: function(message, encoding) {
        logger.info(message)
      }
    }
  }

  // setup Express
  let app = express()
  if (app.get('env') === 'development') {
    Mincer.logger.use(logger)
  } else {
    expressLoggerOptions.format = 'short'
    // In production we assume that assets are not changed between requests,
    // so we use cached version of environment.
    // All file system methods are cached for the instances lifetime.
    dashing.mincer.environment = dashing.mincer.environment.index
  }
  app.set('views', dashing.views)
  app.set('view engine', dashing.view_engine)
  if (dashing.view_engine === 'ejs') {
    app.use(require('express-ejs-layouts'))
  }
  app.use(morgan('dev'))
  app.use(errorHandler())
  app.use(compression())
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({extended: true}))
  app.use(methodOverride())
  app.use(dashing.mincer.assets_prefix, Mincer.createServer(dashing.mincer.environment))
  app.use(serveStatic(dashing.public_folder))
  app.set('development', dashing.NODE_ENV === 'development')
  app.set('production', dashing.NODE_ENV === 'production')

  let connections = {}
  let conn
  /* Set Custom Routes */
  // Load route files
  app.use(router)
  app.get('/events', dashing._protected, function(req, res) {
    // let request last as long as possible
    req.socket.setTimeout(0)

    if (!dashing.force_close_event_socket) {
      // this won't be necessary if we close the connection after each data package
      conn = {
        id: (new Date().getTime().toString() + Math.floor(Math.random() * 1000).toString()),
        send: function(body) {
          res.write(body)
          res.flush() // need to flush with .compress()
        }
      }
      connections[conn.id] = conn
    }

    // send headers for event-stream connection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering for nginx
      'Access-Control-Allow-Origin': '*' //fix XHR issue
    })
    res.write('\n')
    res.write(Array(2049).join(' ') + '\n') // 2kb padding for IE
    latest_events()
      .then( function(events) {
        if(events) {
          res.write(events)
        }
      }).done(function() {
      res.flush() // need to flush with .compress()
    })

    if (!dashing.force_close_event_socket) {
      req.on('close', function() {
        delete connections[conn.id]
      })
    }
    else {
      res.end()
    }
  })

  app.get('/', function(req, res) {
    if (dashing.default_dashboard) {
      res.redirect(dashing.default_dashboard)
    } else {
      first_dashboard(function(err, dashboard) {
        if (err) {
          next(err)
        } else if (dashboard) {
          res.redirect(dashboard)
        } else {
          next(new Error('There are no dashboards in your dashboard directory.'))
        }
      })
    }
  })

  app.get('/:dashboard', dashing._protected, function(req, res) {
    let dashboard = req.params.dashboard
    fs.exists([dashing.views, dashboard + '.' + dashing.view_engine].join(path.sep), function(exists) {
      if (exists) {
        let templateVars = {
          dashboard: dashboard,
          request: req
        }
        let settingsPath = [dashing.settings, dashboard + '.json'].join(path.sep)
        fs.exists(settingsPath, function(exists) {
          if (exists) {
            templateVars.settings = require(settingsPath)
          }
          res.render(dashboard, templateVars)
        })
      } else {
        res.status(404).sendFile(dashing.public_folder + '/404.html')
      }
    })
  })

  app.get('/views/:widget?.html', dashing._protected, function(req, res) {
    let widget = req.params.widget
    res.sendFile([dashing.root, 'widgets', widget, widget + '.html'].join(path.sep))
  })

  app.post('/widgets/:id', function(req, res) {
    let auth_token = req.body.auth_token
    if (!dashing.auth_token || dashing.auth_token === auth_token) {
      send_event(req.params.id, req.body)
      res.send(204)
    } else {
      res.status(401).send('Invalid API key')
    }
  })

  // The 404 Route (ALWAYS Keep this as the last route)
  app.use(function(req, res, next) {
    res.status(404).sendFile(dashing.public_folder + '/404.html')
  })

  // Error handler
  app.use(function(err, req, res, next) {
    logger.error(err.stack)
    res.status(500).send(err)
  })

  function send_event(id, body) {
    body.id = id
    body.updatedAt = Date.now()
    let event = format_event(body)
    dashing.history.record(id, event)
    for (let k in connections) {
      connections[k].send(event)
    }
  }
  global.send_event = send_event

  function format_event(body) {
    return 'data: ' + JSON.stringify(body) + '\n\n'
  }

  function latest_events() {
    return Promise
      .resolve(dashing.history.getAll()) // assure trusted promise
      .reduce( function(agg, next) {
        return agg + next
      })
  }

  function first_dashboard(fn) {
    fs.readdir(dashing.views, function(err, files) {
      if (err) fn(err)
      let regex = new RegExp('(\w*)\.' + dashing.view_engine + '$')
      for (let i in files) {
        let file = files[i]
        if (file.match(regex) && file !== 'layout.' + dashing.view_engine) {
          fn(null, file.substring(0, file.length - (dashing.view_engine.length + 1)))
          return
        }
      }
      fn(null, null)
    })
  }

  // Load custom libraries
  fs.readdir([dashing.root, 'lib'].join(path.sep), function(err, files) {
    if (err) throw err
    for (let i in files) {
      let file = [dashing.root, 'lib', files[i]].join(path.sep)
      require(file)
    }
  })

  function start_jobs() {
    // Load jobs files
    let job_path = process.env.JOB_PATH || [dashing.root, 'jobs'].join(path.sep)
    logger.info('Searching for jobs in', job_path)
    fs.readdir(job_path, function(err, files) {
      if (err) throw err
      for (let i in files) {
        let file = [job_path, files[i]].join(path.sep)
        if (file.match(/(\w*)\.job\.(js|coffee)$/)) {
          logger.info('Loading job file:', files[i])
          try {
            require(file)
          } catch (e) {
            console.error('error while loading job (%s): ', file, e, e.stack)
          }
        }
      }
    })
  }

  function start_express() {
    app.listen(dashing.port)
    logger.info('Listening on http://0.0.0.0:' + dashing.port + (process.env.__daemon === 'false' ? ', CTRL+C to stop' : ''))
  }

  dashing.useHistoryStore = function(store) {
    dashing.history = store
  }

  dashing.start = function() {
    try {
      start_jobs()
      start_express()
    } catch(e) {
      logger.error("Unable to start dashing")
      logger.error(e.toString()) // winston is not catching these?
    }
  }
  dashing.useHistoryStore(new InMemoryHistory())
  dashing.app = app
  return dashing
}
