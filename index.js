if (process.env.NODE_ENV === 'development') {
    require('dotenv').config();
}

var express = require('express');
var passport = require('passport');
var FacebookStrategy = require('passport-facebook').Strategy;
var session = require('express-session')
var bodyParser = require('body-parser')
var cookieParser = require('cookie-parser')
var methodOverride = require('method-override');
var request = require('request');
var crypto = require('crypto');

var app = express();
var server;

function ensureAuthenticated (req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }

    res.redirect(401, '/welcome')
}

function initializeUser (accessToken, refreshToken, profile, done) {
    var admin = {
        user: process.env.COUCH_USERNAME,
        pass: process.env.COUCH_PASSWORD
    };
    var username = profile.id;
    var dbUrl = process.env.COUCH_URL + '/user_' + username;
    var urlFragments = dbUrl.split('://');
    var password;

    // Try to get the user.
    request.get({
        url: process.env.COUCH_URL +  '/_users/org.couchdb.user:' + username,
        auth: admin
    }, function (err, res) {
        var password;
        var cipher;

        if (err) return done(err);

        // User doesn't exist.
        if (res.statusCode === 404) {
            cipher = crypto.createCipher('aes192', process.env.COUCH_SECRET);
            password = accessToken.slice(-6);

            cipher.update(password);
 
            // Add the user
            request.put(
                {
                    url: process.env.COUCH_URL + '/_users/org.couchdb.user:' + username,
                    auth: admin,
                    json: true,
                    body: {
                        name: username,
                        password: password,
                        displayName: profile.displayName,
                        accessCode: cipher.final('hex'),
                        type: 'user',
                        roles: [ ]
                    }
                },
                function (err) {
                    if (err) return done(err);

                    // Add a db for the user.
                    request.put({ url: dbUrl, auth: admin }, function (err) {
                        if (err) return done(err);

                        // Add security settings to the db.
                        request.put(
                            {
                                url: dbUrl + '/_security',
                                auth: admin,
                                json: true,
                                body: {
                                    admins: {
                                        names: [ ],
                                        roles: [ ]
                                    },
                                    members: {
                                        names: [ profile.id ],
                                        roles: [ ]
                                    }
                                }
                            },
                            function (err) {
                                if (err) return done(err);

                                done(null, {
                                    url: [
                                        urlFragments.shift(),
                                        '://',
                                        username,
                                        ':',
                                        password,
                                        '@',
                                        urlFragments.shift()
                                    ].join('')
                                });
                            }
                        );
                    });
                }
            );
        } else {
            cipher = crypto.createDecipher('aes192', process.env.COUCH_SECRET);
            cipher.update(JSON.parse(res.body).accessCode, 'hex');

            password = cipher.final('utf8');
            
            done(null, {
                id: username,
                url: [
                    urlFragments.shift(),
                    '://',
                    username,
                    ':',
                    password,
                    '@',
                    urlFragments.shift()
                ].join('')
            });
        }
    });
}

passport.use(new FacebookStrategy(
    {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: [
            'http://',
            (process.env.NODE_ENV === 'development' ? 'localhost:3000' : 'youbetter.today' ),
            '/auth/facebook/callback'
        ].join('')
    },
    initializeUser
));

//   Passport session setup.
//   To support persistent login sessions, Passport needs to be able to
//   serialize users into and deserialize users out of the session.  Typically,
//   this will be as simple as storing the user ID when serializing, and finding
//   the user by ID when deserializing.  However, since this example does not
//   have a database of user records, the complete Facebook profile is serialized
//   and deserialized.
passport.serializeUser(function(user, done) {
    done(null, user);
});

passport.deserializeUser(function(obj, done) {
    done(null, obj);
}); 
    
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(cookieParser());
app.use(bodyParser.json());
app.use(methodOverride());
// TODO When in production, session needs a data store. 
app.use(session({
    secret: 'you better not tell',
    resave: true,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('www'));

// A landing page with login and marketing info
app.get('/welcome', function (req, res) {
    res.render('welcome');
});

// Destroy the session, clear the cookie and redirect to the welcome page
app.get('/logout', function (req, res) {
    req.session.destroy(function () {
        res.clearCookie('connect.sid', { path: '/' });
        // TODO This redirect should force the cache to be overridden.
        res.redirect('/');
    });
});

// Return the database url based on the user id and access token
// generating it if it doesn't exist
// Request should contain req.query.token and req.query.user
// e.g. /database?token=1234543456567&user=876787678
// TODO Error handling
// TODO Needs HTTPS
app.get('/database', function (req, res) {
    if (!req.query.user || !req.query.token) {
        res.status(400).send('Missing token or user query parameters');
    }

    // Authenticate the token with Facebook
    request.get(
        {
            url: 'https://graph.facebook.com/debug_token',
            qs: {
                input_token: req.query.token,
                access_token: process.env.FACEBOOK_APP_ID + '|' + process.env.FACEBOOK_APP_SECRET
            }
        },
        function (err, debugRes) {
            var tokenData = JSON.parse(debugRes.body).data

            if (tokenData.app_id === process.env.FACEBOOK_APP_ID && tokenData.user_id === req.query.user) {
                initializeUser(req.query.token, null, { id: req.query.user }, function (err, user) {
                    res.type('application/json').send(user);
                }); 
            }
        }
    )
});

// Initiates OAuth with Facebook API
app.get('/auth/facebook', passport.authenticate('facebook'));

// Called by Facebook after OAuth is complete
app.get('/auth/facebook/callback', passport.authenticate('facebook', {
    successRedirect: '/',
    failureRedirect: '/welcome'
}));

// Returns the desktop-app with user info
// TODO Ideally this would be cacheable to allow offline work with above caveat
// Would the combination of the right http header with the appropriate response code 
// do the trick for caching?
app.get('/', ensureAuthenticated, function (req, res) {
    res.render('index', {
        id: req.user.id,
        url: req.user.url
    });
});

server = app.listen(process.env.PORT || 3000);
