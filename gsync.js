#!/usr/bin/env node

var googleapis = require('googleapis'),
    readline = require('readline'),
    fs = require('fs'),
    program = require('commander'),
    async = require('async'),
    multimeter = require('multimeter');

	var multi;

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

var auth, client, drive;

var tokens;
var FIELDS='items(fileSize,id,mimeType,title,createdDate),nextPageToken';


var bars = [];
var progress = [];
var deltas = [];

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


program
  .version('0.7')

program
  .command('sync <src> <target>')
  .option('-D, --diff-file <csv_file>', 'Write CSV diff file to <csv_file>')
  .option('-L, --limit-changes <percent>', 'Allow sync of changes up to <percent> of files, 1% by default', 1)
  .option('-R, --reparent <location>', 'Reparent files to be deleted to this location on your google drive', 'toDelete')
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

  program
  .command('test')
  .description('test')
  .action(function(){
    console.log('test');
    test();
  });

  program.on('*', function(args){
    console.log('Unknown command %s', args[0]);
    program.help();
  });


program.parse(process.argv);
if (!program.args.length) program.help();

function gsync(src, target, options, listOnly){
  var dstParentId;
  var toDeleteParentId;
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
       	  findRemotePathRelative('root', [options.reparent || 'toDelete'], false, function (err, result) {
        	if (err){
          		console.error(err);
          		process.exit(6);
        	} else {
	          toDeleteParentId=result;
	          compare(src, dstParentId, function(err, result, toDelete){
	            if (err)console.log(err);
	            var toSyncArr = sortMap(result.filter(function(e){return (!(!!e.remote && e.local.size==e.remote.size))}),'file');
	            //toSyncArr.forEach(function(e,i,a){console.log(e.file);});
	            var toSyncSize = toSyncArr.reduce(function(previousValue, currentElement, index, array){
	              return previousValue + currentElement.local.size;
	            }, 0);
	            console.log('total local files: ' + result.length + ' files to sync: ' + toSyncArr.length + ' total size to upload: ' + bytesToSize(toSyncSize,2)+ ' files to delete(reparent): '+toDelete.length);
	            if (!!options.diffFile){
	              var diffWS=fs.createWriteStream(options.diffFile);
	              diffWS.write('file,size,tosync\n')
	              result.forEach(function(element, index, array){
	                diffWS.write(element.file+ ',' + element.local.size + ',' + ((!!element.remote && element.local.size==element.remote.size)?'0':'1')+'\n');
	              });
	              diffWS.end(function(){process.exit(0)});
	            }
	            if (!listOnly){
	              var impactedFiles=((toSyncArr.length + toDelete.length) / result.length * 100);
	              if (impactedFiles > options.limitChanges){
	                console.error('Sync requires upload/deletion of ' +  impactedFiles.toFixed(2) + '% of the files, over --limit-changes which is limited to ' + options.limitChanges + '%');
	                process.exit(7);
	              } else {
	              	setupUI(4);
	              	async.mapLimit(toDelete, 2, function(item, callback){
	              		drive.files.update({ 'fileId': item, resource: {'parents': [{'id': toDeleteParentId}]}},
                      function(err, result) {
    	            			if (err)console.error(err);
    	            			console.log('file '+item+' reparented');
    	            		   	callback();
    	                    });
	                }, function (err, results){
	                	syncFolderStructure(dstParentId, src, toSyncArr, function(err, results){
		                	if (err)console.error(err);
		                	var p=0
		                	async.mapLimit(toSyncArr, 4, function(item, callback){
		                		var slot=progress.reduce(function(previousValue, currentValue, index, array){
  									       return currentValue==-1?index:previousValue;
								          });
								        progress[slot]=0;
								        pct=p/toSyncArr.length*100;
								        bars[0].percent(pct, Math.round(pct)+'% ('+'hhh'+'/s) ');
								        p++;
		                  	upload(item.remote.parent, item.file, callback, slot);
		                	 }, function (err, results){
		                  		done(err);
		                	})
		              	});
		            })
              	  }
            	};
          	  })
        	}
      	  });
    	}
      });
	}
  });
}


function setupUI(threads){
	multi = multimeter(process);
	multi.on('^C', process.exit);

	var bar = multi.rel(13, threads, {
        width : 20,
        solid : {
            text : '|',
            foreground : 'white',
            background : 'green'
        },
        empty : { text : ' ' },
    });
    deltas[threads]={'t': new Date().getTime(), 's':0}
    bars.push(bar);
    progress.push(-1);

    multi.write('Total\n');

	for (var i = 0; i < threads; i++) {
	    var s = 'ABCDE'[i] + ': \n';
	    multi.write('Thread: '+s);

	    var bar = multi.rel(13, i, {
	        width : 20,
	        solid : {
	            text : '|',
	            foreground : 'white',
	            background : 'blue'
	        },
	        empty : { text : ' ' },
	    });
	    deltas[i]={'t': new Date().getTime(), 's':0}
	    bars.push(bar);
	    progress.push(-1);
	}

	multi.offset+=1;

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
  if (err){debugger;console.error(err);}
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
        drive.files.get({'fileId': 'root'},function(err,resp) {callback(err);});
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
  auth = new googleapis.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URL);
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
  auth = new googleapis.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URL);
  auth.credentials=tokens;
  googleapis.options({auth: auth});
  drive = googleapis.drive('v2')
  callback();
}

var uploadorg = function (parent, localFile, callback){
  var title = localFile.split('/').pop();
  fs.readFile(localFile, function(err, data) {
    if (err) {
      callback (err);
      return;
    }
    drive.files.list({'maxResults': 2, 'q': '\''+parent+'\' in parents and title=\''+title+'\'', 'fields': FIELDS}),function(err,resp) {
      if (err){
        callback(err);
      } else if (resp.items.length==0){
        var c=drive.files.insert({resource: { title: title, parents: [{'id': parent}]},
          media: {mimeType: mime_types[((/\.([a-z])+/i.exec(title))[0]||'default').toLowerCase()]||mime_types['default'], body: data}},
            function(err, result) {
            //console.log('error:', err, 'inserted:', localFile);
            //multi.offset += 2;
            callback(err,result);
         });
      } else if (resp.items.length==1){
        var c=drive.files.update({ 'fileId': resp.items[0].id,
          media: {mimeType: mime_types[((/\.([a-z])+/i.exec(title))[0]||'default').toLowerCase()]||mime_types['default'], body: data}},
            function(err, result) {
              console.log('error:', err, 'inserted:', localFile);
              callback(err,result);
         });
      } else {
        console.error('Multiple remote files exist for file ' + localFile + ' unable to sync.');
        callback();
      }
    };
  });
}

var upload = function (parent, localFile, callback, slot){
  var title = localFile.split('/').pop();
  fs.readFile(localFile, function(err, data) {
    if (err) {
      callback (err);
      return;
    }
    drive.files.list({'maxResults': 2, 'q': '\''+parent+'\' in parents and title=\''+title+'\'', 'fields': FIELDS}, function(err,resp) {
      if (err){
        callback(err);
      } else if (resp.items.length==0){
        var iv;
        var c=drive.files.insert({resource: { title: title, parents: [{'id': parent}]},
          media: {mimeType: mime_types[((/\.([a-z])+/i.exec(title))[0]||'default').toLowerCase()]||mime_types['default'], body: data}},
            function(err, result) {
            //console.log('error:', err, 'inserted:', localFile);
        			clearInterval(iv);
        			progress[slot]=-1;
        			deltas[slot]={'t': new Date().getTime(), 's':0};
              callback(err,result);
         });

        var req=c;
    		req.on('request', function(r2) {
    			r2.on('socket', function(socket){
    					iv=setInterval(function(){
    					var throughput = bytesToSize((socket.bytesWritten-deltas[slot].s)/((new Date().getTime()-deltas[slot].t)/1000),2);
    					deltas[slot]={'t': new Date().getTime(), 's':socket.bytesWritten}
    					var p=socket.bytesWritten/data.length*100;
    					progress[slot]=p;
    					bars[slot].percent(progress[slot], Math.round(p)+'% ('+throughput+'/s) '+title+'                  ');
    				},500);
    			})
    		})
      } else if (resp.items.length==1){
        var c=drive.files.update({'fileId': resp.items[0].id,
          media: {mimeType: mime_types[((/\.([a-z])+/i.exec(title))[0]||'default').toLowerCase()]||mime_types['default'], body: data}},
            function(err, result) {
              //console.log('error:', err, 'inserted:', localFile);
             callback(err,result);
         });
      } else {
        console.error('Multiple remote files exist for file ' + localFile + ' unable to sync.');
        callback();
      }
    });
  });
}


function test(callback){

	setupUI();

	verifyAuthorization(function(err){
		[0,1,2,3,4].map(function(i){
		fs.readFile('c:/temp/2.bin', function(err, data) {
			//console.log(i);
			if (err)console.error(err);
			//console.log('start upload')
		    var c=drive.files.insert({resource: { title: '2.bin', parents: [{'id': 'root'}]},
          media: {mimeType: mime_types[((/\.([a-z])+/i.exec('1.bin'))[0]||'default').toLowerCase()]||mime_types['default'], body: data}},
          function(err, result) {
    		    console.log('error:', err, 'inserted:', result);
    		    	var c=drive.files.insert({ resource: { title: '3.bin', parents: [{'id': 'root'}]},
                media: {mimeType: mime_types[((/\.([a-z])+/i.exec('1.bin'))[0]||'default').toLowerCase()]||mime_types['default'], body: data}},
                  function(err, result) {});
			     });
			var req=c.authClient.transporter.innerRequest;
			req.on('request', function(r2) {

					r2.on('socket', function(socket){
						//console.log('============ socket ==========');


						//setInterval(function(){console.log('dispatched by '+i+':'+socket.socket.bytesWritten+' '+data.length)},500);
						var iv=setInterval(function(){
							var throughput = 0//bytesToSize((socket.socket.bytesWritten-deltas[i].s)/((new Date().getTime()-deltas[i].t)/1000),2);
							//console.log(throughput+'/S')
							deltas[i]={'t': new Date().getTime(), 's':0}//socket.socket.bytesWritten}
							var p=0//socket.socket.bytesWritten/data.length*100;
							progress[i]=p;
							bars[i].percent(progress[i], Math.round(p)+'% ('+throughput+'/s)');
							if (p>=100) clearInterval(iv);
						},500);
					})
				})

		});

})
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
          drive.files.insert({resource: { title: title, parents: [{'id': parent}], mimeType: 'application/vnd.google-apps.folder'}},
            function(err, result) {
              //console.log('error:', err, 'created folder:', result.id);
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

function listFiles(q, callback){
  drive.files
  .list({'maxResults': 100, 'q': q, 'fields': FIELDS}, function(err,resp) {
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
function retrieveAllFiles(q, errCount, callback) {
  var retrievePageOfFiles = function(request, result, q) {
    request.execute(function(err,resp) {
      if (err){
          console.log(err);
          callback(err, errCount);
      } else {
        result = result.concat(resp.items);
        retrieved+=result.length;
        if (retrieved>0) console.log('Retrieved ',retrieved)
        var nextPageToken = resp.nextPageToken;
        if (nextPageToken) {
          request = {execute: function(f) {drive.files.list({
            'pageToken': nextPageToken,
            'maxResults': 1000,
            'q': q,
            'fields': FIELDS
          },f)}};
          retrievePageOfFiles(request, result, q);
        } else {
          callback(null, errCount, result);
        }
      }
    });
  }
  var initialRequest = {execute: function(f) {drive.files.list({'maxResults': 1000, 'q': q, 'fields': FIELDS},f)}};
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

function retrieveRemoteFolder(parent, errCount, resp){
  if (!!parent)
    retrieveAllFiles('\''+parent+'\' in parents', errCount, resp);
  else
    resp();
}

function compare(localdir, remotedir, done) {
  	var results = [];
  	var toDelete =[];
  	var remotefiles = [];
  	function compareInner(localdir,result, done){
		for (var item in result){
			if (!remotefiles[result[item].title])
				remotefiles[result[item].title]=[result[item]];
			else
				remotefiles[result[item].title].push(result[item]);
		};
	    fs.readdir(localdir, function(err, list) {
	      if (err) return done(err);
	      var pending = list.length;
	      if (!pending) return done(null, results, toDelete);
	      list.forEach(function(filename){
	        var file = localdir + '/' + filename;
	        fs.stat(file, function(err, stat) {
	          if (stat && stat.isDirectory()) {
	            var rdir=null;
	            if (!!remotefiles[filename] && remotefiles[filename].length>1){
	            	callback('duplicate folder '+filename+'found at remote location, unable to recover.');
	            	return;
	            }
	            if (!!remotefiles[filename] && remotefiles[filename][0].mimeType=='application/vnd.google-apps.folder'){
	            	rdir=remotefiles[filename][0].id;
	            	delete remotefiles[filename];
	            }
	            compare(file, rdir, function(err, res, todel) {
	              results = results.concat(res);
	              toDelete = toDelete.concat(todel);
	              if (!--pending){
	              	for (var j in remotefiles) if (remotefiles[j]) for (var k in remotefiles[j]) {toDelete.push(remotefiles[j][k].id);}
	              	done(null, results, toDelete);
	              }
	            });
	          } else {
	          	var i=0;
	          	if (!!remotefiles[filename] && remotefiles[filename].length>1){
	          		for (i in remotefiles[filename]) if (remotefiles[filename][i].filesize==stat.size) break;
	          		for (var j in remotefiles[filename]) if (j!=i) toDelete.push(remotefiles[filename][j].id);
	          	}
	            results.push({
	              'file': file,
	              'local': {
	                'size': stat.size,
	                'created': stat.ctime},
	              'remote': !!remotefiles[filename]?{
	              	'id': remotefiles[filename][i].id,
	                'size': remotefiles[filename][i].fileSize,
	                'created': remotefiles[filename][i].createdDate} : null
	            });
	            delete remotefiles[filename];
	            if (!--pending){
	            	for (var j in remotefiles) if (remotefiles[j]) for (var k in remotefiles[j]) {toDelete.push(remotefiles[j][k].id);}
	            	done(null, results, toDelete);
	            }
	          }
	        });
	      });
	    });
	}

	function retryWrapper(err, errCount, result) {
		if (err){
  			if (errCount>=3){
  				console.error ('Failure to retrieve remote file list, beyond retry threashold.');
				done(err);
  			} else {
  				console.error ('Failure to retrieve remote file list, retrying...');
  				setTimeout(function(){retrieveRemoteFolder(remotedir, errCount+1, retryWrapper),500});
  			}
	  	} else {
	  		compareInner(localdir,result, done);
	  	}
	}

	retrieveRemoteFolder(remotedir, 0, retryWrapper);
};
