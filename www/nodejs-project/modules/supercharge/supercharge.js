function patch(scope){
	if (!scope.String.prototype.format) {
		Object.defineProperty(String.prototype, 'format', {
			enumerable: false,
			configurable: false,
			writable: false,
			value: function (){
				var args = arguments;
				return this.replace(/{(\d+)}/g, function(match, number) {
				return typeof args[number] != 'undefined'
					? args[number]
					: match
				})
			}
		})
	}
	if (!scope.String.prototype.matchAll) {
		Object.defineProperty(String.prototype, 'matchAll', {
			enumerable: false,
			configurable: false,
			writable: false,
			value: function(regexp) {
				var matches = []
				this.replace(regexp, function() {
					var arr = ([]).slice.call(arguments, 0)
					var extras = arr.splice(-2)
					arr.index = extras[0]
					arr.input = extras[1]
					matches.push(arr)
				})
				return matches.length ? matches : []
			}
		})
	}	
	if (!scope.Array.prototype.sortByProp) {
		Object.defineProperty(Array.prototype, 'sortByProp', {
			enumerable: false,
			configurable: false,
			writable: false,
			value: function (p, reverse) {
				if(Array.isArray(this)){ // this.slice is not a function (?!)
					return this.slice(0).sort((a,b) => {
						let ua = typeof(a[p]) == 'undefined', ub = typeof(b[p]) == 'undefined'
						if(ua && ub) return 0
						if(ua && !ub) return reverse ? 1 : -1
						if(!ua && ub) return reverse ? -1 : 1
						if(reverse) return (a[p] > b[p]) ? -1 : (a[p] < b[p]) ? 1 : 0;
						return (a[p] > b[p]) ? 1 : (a[p] < b[p]) ? -1 : 0;
					})
				}
				return this
			}
		})
	}
	if (!scope.Number.prototype.between) {
		Object.defineProperty(Number.prototype, 'between', {
			enumerable: false,
			configurable: false,
			writable: false,
			value: function(a, b) {
				var min = Math.min(a, b), max = Math.max(a, b)
				return this >= min && this <= max
			}
		})
	}
	if (!scope.String.prototype.replaceAll) {
		Object.defineProperty(String.prototype, 'replaceAll', {
			enumerable: false,
			configurable: false,
			writable: false,
			value: function(search, replacement) {
				let target = this
				if(target.indexOf(search)!=-1){
					target = target.split(search).join(replacement)
				}
				return String(target)
			}
		})
	}
    scope.validateURL = url => {
		if(url && url.length > 11){
			let u = url.toLowerCase()
			if(u.match(new RegExp('^(https?://|//)', 'i'))){
				let domain = u.split('//')[1].split('/')[0]
				if(domain.match(new RegExp('^[A-Za-z0-9_\\-\\.\\:@]{4,}$'))){
					return true
				}
			}
		}
    }
	scope.decodeURIComponentSafe = uri => {
		try {
			return decodeURIComponent(uri)
		} catch(e) {
			return uri.replace(new RegExp('%[A-Z0-9]{0,2}', 'gi'), x => {
				try {
					return decodeURIComponent(x)
				} catch(e) {
					return x
				}
			})
		}
	}
	if(typeof(require) == 'function'){
		if(typeof(scope.URL) != 'undefined'){ // node
			scope.URL = require('url').URL
		}
		if(typeof(scope.URLSearchParams) == 'undefined'){ // node
			scope.URLSearchParams = require('url-search-params-polyfill')
		}
	}
	scope.deepClone = (from, allowNonSerializable) => {
		if (from == null || typeof from != "object") return from
		if (from.constructor != Object && from.constructor != Array) return from
		if (from.constructor == Date || from.constructor == RegExp || from.constructor == Function ||
			from.constructor == String || from.constructor == Number || from.constructor == Boolean)
			return new from.constructor(from)
		let to = new from.constructor()
		for (var name in from){
			if(allowNonSerializable || ['string', 'object', 'number', 'boolean'].includes(typeof(from[name]))){
				to[name] = typeof to[name] == "undefined" ? scope.deepClone(from[name], allowNonSerializable) : to[name]
			}
		}
		return to
	}
	scope.kfmt = (num, digits) => {
		var si = [
			{ value: 1, symbol: "" },
			{ value: 1E3, symbol: "K" },
			{ value: 1E6, symbol: "M" },
			{ value: 1E9, symbol: "G" },
			{ value: 1E12, symbol: "T" },
			{ value: 1E15, symbol: "P" },
			{ value: 1E18, symbol: "E" }
		]
		var i, rx = /\.0+$|(\.[0-9]*[1-9])0+$/
		for (i = si.length - 1; i > 0; i--) {
			if (num >= si[i].value) {
				break
			}
		}
		return (num / si[i].value).toFixed(digits).replace(rx, "$1") + si[i].symbol
	}
	scope.kbfmt = (bytes, decimals = 2) => { // https://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript
		if (isNaN(bytes) || typeof(bytes) != 'number') return 'N/A'
		if (bytes === 0) return '0 Bytes'
		const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
	}
	scope.kbsfmt = (bytes, decimals = 1) => { // https://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript
		if (isNaN(bytes) || typeof(bytes) != 'number') return 'N/A'
		if (bytes === 0) return '0 Bytes/ps'
		const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes/ps', 'KBps', 'MBps', 'GBps', 'TBps', 'PBps', 'EBps', 'ZBps', 'YBps']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
	}
	scope.componentToHex = (c) => {
		var hex = c.toString(16);
		return hex.length == 1 ? '0' + hex : hex
	}
	scope.rgbToHex = (r, g, b) => {
		return '#'+ scope.componentToHex(r) + scope.componentToHex(g) + scope.componentToHex(b)
	}
	scope.hexToRgb = ohex => {
		var shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i, hex = ohex.replace(shorthandRegex, (m, r, g, b) => {
			return r + r + g + g + b + b
		})
		var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
		return result ? {
			r: parseInt(result[1], 16),
			g: parseInt(result[2], 16),
			b: parseInt(result[3], 16)
		} : ohex
	}
    scope.ucWords = (str, force) => {
		if(!force && str != str.toLowerCase()){
			return str
		}
        return str.replace(new RegExp('(^|[ ])[A-zÀ-ú]', 'g'), letra => {
            return letra.toUpperCase()
        })
	}
	scope.ucFirst = (str, keepCase) => {
		if(!keepCase){
			str = str.toLowerCase()
		}
		return str.replace(/^[\u00C0-\u1FFF\u2C00-\uD7FF\w]/g, letter => {
			return letter.toUpperCase()
		})
	}
	scope.getArrayMax = arr => { // https://stackoverflow.com/questions/42623071/maximum-call-stack-size-exceeded-with-math-min-and-math-max
		let len = arr.length
		let max = -Infinity
		while (len--) {
			if(arr[len] > max) max = arr[len]
		}
		return max
	}
	scope.getArrayMin = arr => {
		let len = arr.length
		let min = Infinity
		while (len--) {
			if(arr[len] < min) min = arr[len]
		}
		return max
	}
	scope.hmsClockToSeconds = str => {
		var cs = str.split('.'), p = cs[0].split(':'), s = 0, m = 1;    
		while (p.length > 0) {
			s += m * parseInt(p.pop(), 10);
			m *= 60;
		}    
		if(cs.length > 1 && cs[1].length >= 2){
			s += parseInt(cs[1].substr(0, 2)) / 100;
		}
		return s
	}
	scope.hmsSecondsToClock = secs => {
		var sec_num = parseInt(secs, 10); // don't forget the second param
		var hours   = Math.floor(sec_num / 3600);
		var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
		var seconds = sec_num - (hours * 3600) - (minutes * 60);    
		if (hours   < 10) {hours   = "0"+hours;}
		if (minutes < 10) {minutes = "0"+minutes;}
		if (seconds < 10) {seconds = "0"+seconds;}
		return hours+':'+minutes+':'+seconds;
	}
	scope.ts2clock = time => {
		let locale = undefined, timezone = undefined
		if(typeof(time) == 'string'){
			time = parseInt(time)
		}
		time = global.moment(time * 1000)
		return time.format('LT')
	}
	scope.getUniqueFilenameHelper = (name, i) => {
		let pos = name.lastIndexOf('.')
		if(pos == -1){
			return name + '-' + i
		} else {
			return name.substr(0, pos) + '-' + i + name.substr(pos)
		}
	}
	scope.getUniqueFilename = (files, name) => {
		let i = 0, nname = name
		while(files.includes(nname)){
			i++
			nname = scope.getUniqueFilenameHelper(name, i)
		}
		return nname
	}	
	scope.traceback = () => { 
		try { 
			var a = {}
			a.debug()
		} catch(ex) {
			return ex.stack.replace('TypeError: a.debug is not a function', '').trim()
		}
	}
	scope.forwardSlashes = path => {
		if(path && path.indexOf('\\') != -1){
			return path.replaceAll('\\', '/').replaceAll('//', '/')
		}
		return path
	}	
    scope.joinPath = (folder, file) => {
		if(!file) return folder
		if(!folder) return file
		let ffolder = folder
		let ffile = file
		if(ffolder.indexOf('\\') != -1) {
			ffolder = scope.forwardSlashes(ffolder)
		}
		if(ffile.indexOf('\\') != -1) {
			ffile = scope.forwardSlashes(ffile)
		}
		let folderEndsWithSlash = ffolder.charAt(ffolder.length - 1) == '/'
		let fileStartsWithSlash = ffile.charAt(0) == '/'
		if(fileStartsWithSlash && folderEndsWithSlash) {
			ret = ffolder + ffile.substr(1)
		} else if(fileStartsWithSlash || folderEndsWithSlash) {
			ret = ffolder + ffile
		} else {
			ret = ffolder +'/'+ ffile
		}
        return ret
    }
	scope.time = () => {
		return Date.now() / 1000
	}
	scope.isVODM3U8 = (content, contentLength) => {
        let sample = String(content).toLowerCase()
		if(sample.indexOf('#ext-x-playlist-type:vod') != -1) return true
		if(sample.match(new RegExp('#ext-x-media-sequence:0[^0-9]'))) return true
		let pe = sample.indexOf('#ext-x-endlist')
		let px = sample.lastIndexOf('#extinf')
		if(pe != -1){
			return pe > px
		}
		if(sample.indexOf('#ext-x-program-date-time') == -1){
			let pieces = sample.split('#extinf')
			if(pieces.length > 30){
				return true
			}
			if(typeof(contentLength) == 'number' && pieces.length > 2){ //  at least 3 pieces, to ensure that the first extinf is complete
				let header = pieces.shift()
				let pieceLen = pieces[0].length + 7
				let totalEstimatedPieces = (contentLength - header.length) / pieceLen
				if(totalEstimatedPieces > 30){
					return true
				}
			}
		}
	}
	scope.filenameFromURL = (url, defaultExt = 'mp4') => {
		let filename = url.split('?')[0].split('/').filter(s => s).pop()
		if(!filename || filename.indexOf('=') != -1){
			filename = 'video'
		}
		if(filename.indexOf('.') == -1){
			filename += '.' + defaultExt
		}
		return scope.sanitize(filename)
	}
	scope.isWritable = stream => {
		return (stream.writable || stream.writeable) && !stream.finished
	}	
    scope.checkDirWritePermission = async dir => {
        const file = dir +'/temp.txt', fsp = scope.getFS().promises
        await fsp.writeFile(file, '0')
		await fsp.unlink(file)
		return true
    }
    scope.checkDirWritePermissionSync = dir => {
        let fine
		const file = dir +'/temp.txt', fs = scope.getFS()
        try {
			fs.writeFileSync(file, '0')
			fine = true
			fs.unlinkSync(file)
		} catch(e) {
			console.error(e)
		}
		return fine
    }
	scope.rmdir = (folder, itself, cb) => {
		const rimraf = require('rimraf')
		let dir = folder
		if(dir.charAt(dir.length - 1) == '/'){
			dir = dir.substr(0, dir.length - 1)
		}
		if(!itself){
			dir += '/*'
		}
		if(cb === true){ // sync
			try {
				rimraf.sync(dir)
			} catch(e) {}
		} else {
			try {
				rimraf(dir, cb || (() => {}))
			} catch(e) {
				if(typeof(cb) == 'function'){
					cb()
				}
			}
		}
	}
	scope.dirname = _path => {
		let parts = _path.replace(new RegExp('\\\\', 'g'), '/').split('/')
		parts.pop()
		return parts.join('/')
	}
	scope.getFS = () => {
		if(!scope.__fs){
			scope.__fs = require('fs')
		}
		return scope.__fs
	}
	scope._moveFile = async (from, to) => {
		const fs = scope.getFS()
		const fstat = await fs.promises.stat(from).catch(console.error)
		if(!fstat) throw '"from" file not found'
		let err
		await fs.promises.copyFile(from, to).catch(e => err = e)
		let tstat
		if(typeof(err) != 'undefined'){
			tstat = await fs.promises.stat(to).catch(console.error)
			if(tstat && tstat.size == fstat.size){
				err = null
			}
		}
		if(err){
			throw err
		}
		fs.promises.unlink(from).catch(() => {})
		return true
	}
	scope.moveFile = (from, to, _cb, timeout=5, until=null, startedAt = null, fromSize=null) => {
		const fs = scope.getFS(), now = scope.time(), cb = () => {
			if(_cb){
				_cb()
				_cb = null
			}
		}
		if(until === null){
			until = now + timeout
		}
		if(startedAt === null){
			startedAt = now
		}
		const move = () => {
			scope._moveFile(from, to).then(() => cb()).catch(err => {
				if(until <= now){
					fs.access(from, (err, stat) => {
						console.error('MOVERETRY GAVEUP AFTER '+ (now - startedAt) +' SECONDS', err, fromSize, err)
						return cb(err)
					})
					return
				}
				fs.stat(to, (ferr, stat) => {
					if(stat && stat.size == fromSize){
						cb()
					} else {
						fs.stat(from, (err, stat) => {
							if(stat && stat.size == fromSize){
								setTimeout(() => {
									scope.moveFile(from, to, cb, timeout, until, startedAt, fromSize)
								}, 500)
							} else {
								console.error('MOVERETRY FROM FILE WHICH DOESNT EXISTS ANYMORE', err, stat)
								console.error(ferr, err)
								cb(err || '"from" file changed')
							}
						})
					}
				})
			})
		}
		if(fromSize === null){
			fs.stat(from, (err, stat) => {
				if(err){
					console.error('MOVERETRY FROM FILE NEVER EXISTED', err)
					cb(err)
				} else {
					fromSize = stat.size
					move()
				}
			})
		} else {
			move()
		}
	}
	scope.execSync = cmd => {
		let stdout
		try {
			stdout = require('child_process').execSync(cmd)
		} catch(e) {
			stdout = String(e)
		}
		return String(stdout)
	}
    scope.isNetworkIP = addr => {
        if(addr){
			if(addr.startsWith('10.') || addr.startsWith('172.') || addr.startsWith('192.')){
				return 'ipv4'
			}
		}
    }
	scope.androidSDKVer = () => {
		if(!scope.androidSDKVerCache){
			scope.androidSDKVerCache = parseInt(scope.execSync('getprop ro.build.version.sdk').trim())
		}
		return scope.androidSDKVerCache
	}	
	scope.os = () => {
		if(!scope.osCache){
			scope.osCache = require('os')
		}
		return scope.osCache
	}
	scope.networkIpCache = false
	scope.networkIpCacheTTL = 10
	scope.networkDummyInterfaces = addr => {
		return {
			"Wi-Fi": [
				{
					"address": addr,
					"netmask": "255.255.255.0",
					"family": "IPv4",
					"mac": "00:00:00:00:00:00",
					"internal": false
				}
			],
			"Loopback Pseudo-Interface 1": [
				{
					"address": "127.0.0.1",
					"netmask": "255.0.0.0",
					"family": "IPv4",
					"mac": "00:00:00:00:00:00",
					"internal": true,
					"cidr": "127.0.0.1/8"
				}
			]
		}
	}
	scope.androidIPCommand = () => {
		return scope.execSync('ip route get 8.8.8.8')
	}
	scope.networkInterfaces = () => {
		if(process.platform == 'android'){
			let sdkVer = scope.androidSDKVer()
			if(isNaN(sdkVer) || sdkVer < 20 || sdkVer >= 29){ // keep "sdkVer < x" check
				// on most recent sdks, os.networkInterces() crashes nodejs-mobile-cordova with a uv_interface_addresses error
				let addr, time = scope.time()
				if(scope.networkIpCache && (scope.networkIpCache.time + scope.networkIpCacheTTL) > time){
					addr = scope.networkIpCache.addr
				} else {
					addr = scope.androidIPCommand().match(new RegExp('src +([0-9\.]+)'))
					if(addr){
						addr = addr[1]
						scope.networkIpCache = {addr, time}
					} else {
						addr = scope.networkIpCache ? scope.networkIpCache.addr : '127.0.0.1'
					}
				}
				return scope.networkDummyInterfaces(addr)
			}
		}
		return scope.os().networkInterfaces()
	}
    scope.networkIP = () => {
		let interfaces = scope.networkInterfaces(), addr = '127.0.0.1', skipIfs = new RegExp('(vmware|virtualbox)', 'i')
		for (let devName in interfaces) {
			if(devName.match(skipIfs)) continue
			let iface = interfaces[devName]
			for (let i = 0; i < iface.length; i++) {
				let alias = iface[i]
				if (alias.family === 'IPv4' && !alias.internal && scope.isNetworkIP(alias.address)){
					addr = alias.address
				}
			}
		}
		return addr
	}
    scope.parseJSON = json => { // prevent JSON related crashes
		let ret
		try {
			let parsed = JSON.parse(json)
			ret = parsed
		} catch(e) { }
		return ret
	}
}

if(typeof(module) != 'undefined' && typeof(module.exports) != 'undefined'){
	module.exports = patch
} else {
	patch(window)
}


