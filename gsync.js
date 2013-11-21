#!/usr/bin/env node

var googleapis = require('googleapis'),
    readline = require('readline'),
    fs = require('fs'),
    program = require('commander'),
    async = require('async');

var mime_types= {
                    '.xls' : 'application/vnd.ms-excel',
                    '.xlsx' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    '.xml' : 'text/xml',
                    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
                    '.csv': 'text/plain',
                    '.tmpl': 'text/plain',
                    '.pdf':  'application/pdf',
                    '.php': 'application/x-httpd-php',
                    '.jpg': 'image/jpeg',
                    '.png': 'image/png',
                    '.gif': 'image/gif',
                    '.bmp': 'image/bmp',
                    '.txt': 'text/plain',
                    '.doc': 'application/msword',
                    '.js': 'text/js',
                    '.swf': 'application/x-shockwave-flash',
                    '.mp3': 'audio/mpeg',
                    '.zip': 'application/zip',
                    '.rar': 'application/rar',
                    '.tar': 'application/tar',
                    '.arj': 'application/arj',
                    '.cab': 'application/cab',
                    '.html': 'text/html',
                    '.htm': 'text/html',
                    'default': 'application/octet-stream',
                    'folder': 'application/vnd.google-apps.folder'
                  };

var CLIENT_ID = '481587742723.apps.googleusercontent.com',
    CLIENT_SECRET = 'xPKNXJIDFYyGrT6XyBZ2v5Du',
    REDIRECT_URL = 'urn:ietf:wg:oauth:2.0:oob',
    SCOPE = 'https://www.googleapis.com/auth/drive';

var auth, client;

var tokens /* = { 
  access_token: 'ya29.AHES6ZRXGsn5YOlB5r7L2fbaG0vpyE-DMwuMFs63ksu_wJQ',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: '1/WDepVOjW8VaSmMI57OKKKHyZjVrB8px8v-x2hfdI_YM' 
} */

var FIELDS='items(fileSize,id,mimeType,title,createdDate),nextPageToken';


var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


program
  .version('0.3')

program
  .command('sync <src> <target>')
  .option('-D, --diff-file <csv_file>', 'Write CSV diff file to <csv_file>')
  .option('-L, --limit-changes <percent>', 'Allow sync of changes up to <percent> of files, 1% by default', 1)
  .description('Sync to gdrive')
  .action(function(src, target, options){
    gsync(src.replace(/\\/g,'/'), target, options, false);
  });

  program
  .command('list <src> <target>')
  .option('-D, --diff-file <csv_file>', 'Write CSV diff file to <csv_file>')
  .description('list pending changes only')
  .action(function(src, target, options){
    gsync(src.replace(/\\/g,'/'), target, options, true);
  });

  program
  .command('authorize')
  .description('authorize access to your google drive')
  .action(function(){
    console.log('authorize');
    authorize();
    writeGAPITokens(tokens);
  });

  program.on('*', function(args){
    console.log('Unknown command %s', args[0]);
    program.help();
  });
  

program.parse(process.argv);
if (!program.args.length) program.help();

function gsync(src, target, options, listOnly){
  var dstParentId;
  verifyAuthorization(function(err){
    if (err){
      console.log('Failed to access google drive, try running the \'authorize\' command?');
      console.error(err);
      process.exit(6);
    } else {
      console.log('list %s to %s', src, target);
      findRemotePathRelative('root', target.replace(/\\/g,'/').split('/'), false, function (err, result) {
        if (err){
          console.error(err);
          process.exit(6);
        } else {
          dstParentId=result;
          compare(src, dstParentId, function(err,result){
            if (err)console.log(err);
            var toSyncArr = sortMap(result.filter(function(e){return (!(!!e.remote && e.local.size==e.remote.size))}),'file');
            //toSyncArr.forEach(function(e,i,a){console.log(e.file);});
            var toSyncSize = toSyncArr.reduce(function(previousValue, currentElement, index, array){
              return previousValue + currentElement.local.size;
            }, 0);
            console.log('total local files: ' + result.length + ' files to sync: ' + toSyncArr.length + ' total size to upload: ' + bytesToSize(toSyncSize,2));
            if (!!options.diffFile){
              var diffWS=fs.createWriteStream(options.diffFile);
              diffWS.write('file,size,tosync\n')
              result.forEach(function(element, index, array){
                diffWS.write(element.file+ ',' + element.local.size + ',' + ((!!element.remote && element.local.size==element.remote.size)?'0':'1')+'\n');
              });
              diffWS.end(function(){process.exit(0)});
            } 
            if (!listOnly){
              if (toSyncArr.length / result.length * 100 > options.limitChanges){
                console.error('Sync requires upload of ' + (toSyncArr.length / result.length * 100).toFixed(2) + '% of the files, over --limit-changes which is limited to ' + options.limitChanges + '%');
                process.exit(7);
              } else {
                syncFolderStructure(dstParentId, src, toSyncArr, function(err, results){
                  if (err)console.error(err);
                  async.mapLimit(toSyncArr, 10, function(item, callback){
                    upload(item.remote.parent, item.file, callback);
                  }, function (err, results){
                    done(err);
                  })                  
                });
              }
            };
          })
        }
      });
    }
  });
}

function sortMap(list, field){
  // temporary holder of position and sort-value
  var map = list.map(function(e, i){
    return {index: i, value: e[field].toLowerCase()}
  })
  // sorting the map containing the reduced values
  map.sort(function(a, b) {
    return a.value > b.value ? 1 : -1;
  });
  // container for the resulting order
  var result = map.map(function(e){
    return list[e.index]
  })
  return result;
}

function done(err){
  if (err)console.error(err);
  console.log('complete');
  process.exit(0);
}

function syncFolderStructure(dstParentId, src, toSyncArr, callback){
  var refPath=src.split('/');
  var targetPath;
  var prevPath={'path': null, 'id': null}
  async.mapSeries(toSyncArr, function(element, callback){
    targetPath=element.file.split('/');
    targetPath.pop();//remove filename
    if (prevPath.id && targetPath.toString()==prevPath.path){
      if (!element.remote)element.remote={};
      element.remote.parent=prevPath.id;
      callback();
    } else {
      prevPath.path=targetPath.toString();
      targetPath.splice(0,refPath.length);
      findRemotePathRelative(dstParentId, targetPath, true, function (err, result) {
        if (err) console.error(err);
        if (!element.remote)element.remote={};
        element.remote.parent=result;
        prevPath.id=result;
        callback(err, result);
      });
    }
  }, function(err, results){
    callback(err, results);
  });
}

/**
 * Convert number of bytes into human readable format
 *
 * @param integer bytes     Number of bytes to convert
 * @param integer precision Number of digits after the decimal separator
 * @return string
 */
function bytesToSize(bytes, precision)
{  
    var kilobyte = 1024;
    var megabyte = kilobyte * 1024;
    var gigabyte = megabyte * 1024;
    var terabyte = gigabyte * 1024;
   
    if ((bytes >= 0) && (bytes < kilobyte)) {
        return bytes + ' B';
 
    } else if ((bytes >= kilobyte) && (bytes < megabyte)) {
        return (bytes / kilobyte).toFixed(precision) + ' KB';
 
    } else if ((bytes >= megabyte) && (bytes < gigabyte)) {
        return (bytes / megabyte).toFixed(precision) + ' MB';
 
    } else if ((bytes >= gigabyte) && (bytes < terabyte)) {
        return (bytes / gigabyte).toFixed(precision) + ' GB';
 
    } else if (bytes >= terabyte) {
        return (bytes / terabyte).toFixed(precision) + ' TB';
 
    } else {
        return bytes + ' B';
    }
}

function verifyAuthorization(callback){
  tokens=readGAPITokens();
  if (!tokens) callback('Failure to retrieve tokens'); else {
    discoverGAPI(function(err){
      if (err) 
        callback(err); 
      else
        client.drive.files.get({'fileId': 'root'}).withAuthClient(auth).execute(function(err,resp) {callback(err);});
    })
  }
}

function getUserHome() {
  return process.env.HOMEPATH || process.env.USERPROFILE ||  process.env.HOME;
}

function writeGAPITokens(tokens){
  if (!getUserHome()){
    console.error('Failure to find user home directory.');
    return -1;
  }
  try {
    if (!fs.existsSync(getUserHome()+'/.gsync')) fs.mkdirSync(getUserHome()+'/.gsync');
    fs.writeFileSync(getUserHome()+'/.gsync/tokens',JSON.stringify(tokens));
  }
  catch (err){
    console.error('Failure to save tokens file ', err);
    return -2;
  }
  return 0;
}

function readGAPITokens(){
  var _tokens;
  if (!getUserHome()){
    console.error('Failure to find user home directory.');
    return null;
  }
  try {
    _tokens = JSON.parse(fs.readFileSync(getUserHome()+'/.gsync/tokens',{'encoding': 'utf8'}));
  }
  catch (err){
    console.error('Failure to read tokens file ', err);
    return null;
  }
  return _tokens;
}

function authorize(){
  auth = new googleapis.OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URL);
  var url = auth.generateAuthUrl({ scope: SCOPE });
  var getAccessToken = function(code) {
    auth.getToken(code, function(err,_tokens) {
      if (err) {
        console.error('Error while trying to retrieve access token', err);
      } else if (writeGAPITokens(_tokens)==0) {
        console.log('Application was granted access to your google drive, thank you.');
      }
      process.exit(0);
    });
  };
  console.log('Visit the url:\n', url);
  rl.question('Enter the code here:', getAccessToken);
}

function discoverGAPI(callback){
  auth = new googleapis.OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URL);
  googleapis.discover('drive', 'v2').execute(function(err, _client) {
    auth.credentials=tokens;
    client=_client.withAuthClient(auth); 
    callback(err);
  });
}

var upload = function (parent, localFile, callback){
  var title = localFile.split('/').pop();
  fs.readFile(localFile, function(err, data) {
    if (err) {
      callback (err);
      return;
    }
    client.drive.files.list({'maxResults': 2, 'q': '\''+parent+'\' in parents and title=\''+title+'\'', 'fields': FIELDS}).withAuthClient(auth).execute(function(err,resp) {
      if (err){
        callback(err);
      } else if (resp.items.length==0){
        client.drive.files.insert({ title: title, parents: [{'id': parent}]})
          .withMedia(mime_types[((/\.([a-z])+/i.exec(title))[0]||'default').toLowerCase()], data)
          .withAuthClient(auth)
          .execute(function(err, result) {
            console.log('error:', err, 'inserted:', localFile);
            callback(err,result);
          });
      } else if (resp.items.length==1){
        client.drive.files.update({ 'fileId': resp.items[0].id})
          .withMedia(mime_types[((/\.([a-z])+/i.exec(title))[0]||'default').toLowerCase()], data)
          .withAuthClient(auth)
          .execute(function(err, result) {
            console.log('error:', err, 'inserted:', localFile);
            callback(err,result);
          });
      } else {
        console.error('Multiple remote files exist for file ' + localFile + ' unable to sync.');
        callback();
      }    
    });
  });
}

function findRemotePathRelative(parent, pathArr, mkdir, callback){
  if (pathArr.length==0) callback(null, parent);
  else {
    var title=pathArr.shift();
    listFiles('\''+parent+'\' in parents and title=\''+title+'\' and mimeType=\'application/vnd.google-apps.folder\'', function(files){
      if (!files) 
        callback('Failed to find remote path - api returned error', '');
      else if (files.length==0){
        if (mkdir){
          client.drive.files.insert({ title: title, parents: [{'id': parent}], mimeType: 'application/vnd.google-apps.folder'})
            .withAuthClient(auth)
            .execute(function(err, result) {
              console.log('error:', err, 'created folder:', result.id);
              if (err)callback(err); else findRemotePathRelative(result.id, pathArr, mkdir, callback);
            });
        } else callback('Failed to find remote path - does not exist', null);
      } else if (files.length==1) 
          findRemotePathRelative(files[0].id, pathArr, mkdir, callback);
        else 
          callback('Failed to find remote path - duplicate', null);
    });
  };
}

function aagsync(src, dst){
  listFiles('\'root\' in parents and title=\'Pictures\' and mimeType=\'application/vnd.google-apps.folder\'', function(files){
    if (0 && files.length==1){
      compare('z:/Media/Pictures', files[0].id, function(err,result){
        if (err)console.log(err);
        //console.log(result);
        console.log('file,size,tosync')
        result.forEach(function(element, index, array){
          console.log(element.file+ ',' + element.local.size + ',' + ((!!element.remote && element.local.size==element.remote.size)?'0':'1'));
        });
        process.exit(0)
      })
    }
    upload(files[0].id, 'C:/temp/test-gsync/2003-11-21T03_40_22R76339.JPG');
  });
}; 

function listFiles(q, callback){
  client.drive.files
  .list({'maxResults': 100, 'q': q, 'fields': FIELDS}).withAuthClient(auth).execute(function(err,resp) {
      if (err){console.log(err);};
      callback(!!resp?resp.items:null);
    });
}

var retrieved=0;
/**
 * Retrieve a list of File resources.
 *
 * @param {Function} callback Function to call when the request is complete.
 */
function retrieveAllFiles(q,callback) {
  var retrievePageOfFiles = function(request, result, q) {
    request.withAuthClient(auth).execute(function(err,resp) {
      if (err){
          console.log(err);
          callback(null);
      } else {
        result = result.concat(resp.items);
        retrieved+=result.length;
        if (retrieved>0) console.log('Retrieved ',retrieved)
        var nextPageToken = resp.nextPageToken;
        if (nextPageToken) {
          request = client.drive.files.list({
            'pageToken': nextPageToken,
            'maxResults': 1000,
            'q': q,
            'fields': FIELDS
          });
          retrievePageOfFiles(request, result, q);
        } else {
          callback(result);
        }
      }
    });
  }
  var initialRequest = client.drive.files.list({'maxResults': 1000, 'q': q, 'fields': FIELDS});
  retrievePageOfFiles(initialRequest, [], q);
}

function getAccessToken(oauth2Client, callback) {
  // generate consent page url
  var url = auth.generateAuthUrl({ scope: SCOPE });

  console.log('Visit the url: ', url);
  rl.question('Enter the code here:', function(code) {

    // request access token
    oauth2Client.getToken(code, function(err, tokens) {
      // set tokens to the client
      // TODO: tokens should be set by OAuth2 client.
      oauth2Client.credentials = tokens;
      callback && callback();
    });
  });
}


function findFolder(parent,title, resp){
  if (!!parent)
    listFiles('\''+paernt+'\' in parents and title=\''+title+'\' and mimeType=\'application/vnd.google-apps.folder\'',resp);
  else
    resp(null);
}

function retrieveRemoteFolder(parent, resp){
  if (!!parent)
    retrieveAllFiles('\''+parent+'\' in parents', resp);
  else
    resp(null);
}

function compare(localdir, remotedir, done) {
  var results = [];
  var remotefiles = [];
  retrieveRemoteFolder(remotedir,function(result){
    for (var item in result){remotefiles[result[item].title]=result[item]};
    fs.readdir(localdir, function(err, list) {
      if (err) return done(err);
      var pending = list.length;
      if (!pending) return done(null, results);
      list.forEach(function(filename){
        var file = localdir + '/' + filename;
        fs.stat(file, function(err, stat) {
          if (stat && stat.isDirectory()) {
            var rdir=null;
            if (!!remotefiles[filename] && remotefiles[filename].mimeType=='application/vnd.google-apps.folder') rdir=remotefiles[filename].id;
            compare(file, rdir, function(err, res) {
              results = results.concat(res);
              if (!--pending) done(null, results);
            });           
          } else {
            results.push({
              'file': file,
              'local': {
                'size': stat.size, 
                'created': stat.ctime},
              'remote': !!remotefiles[filename]?{
                'size': remotefiles[filename].fileSize, 
                'created': remotefiles[filename].createdDate} : null
            });
            if (!--pending) done(null, results);
          }
        });
      });
    });
  });
};
