# node-red-contrib-flow-dispatcher
A collection of [Node-RED](http://nodered.org) nodes to read and write Node-RED flows.

## Install
Use npm command to install this package locally in the Node-RED modules directory
```bash
npm install node-red-contrib-flow-dispatcher
```
or globally install with the command
```bash
npm install -g node-red-contrib-flow-dispatcher
```

## Nodes included in the package
**flow reader** Read Node-RED flows from user specified URL.

**flow writer** Write Node-RED flows to user specified URL.

**flow cloner** Read Node-RED flows from localhost and write to user specified URL.

## Usage example
![Flow](./node-red-contrib-flow-dispatcher_drawings.png)
Simple usage of the plugin in Node-RED, click the button on the inject node or flow-cloner node to trigger the dispatching process.
If "Inject once at start/deploy?" is checked in flow-cloner node, the flow will start to execute once it is successfully deployed or Node-Red server starts.
```json
[
	{
		"id":"2c975cfd.d368a4",
		"type":"debug",
		"name":"",
		"active":true,
		"console":"false",
		"complete":"payload",
		"x":618,
		"y":189.00003051757812,
		"z":"2317117.fdce8ee",
		"wires":[]
	},
	{
		"id":"821dc326.7de24",
		"type":"flow-cloner",
		"name":"",
		"url":"192.168.0.1:1880",
		"auth":false,
		"sheet":"Sheet 1",
		"once":false,
		"x":110,
		"y":263,
		"z":"2317117.fdce8ee",
		"wires":[
			["3d3453b3.c2cbac"]
		]
	},
	{
		"id":"6913f4d2.96ec0c",
		"type":"inject",
		"name":"",
		"topic":"",
		"payload":"",
		"payloadType":"date",
		"repeat":"",
		"crontab":"",
		"once":false,
		"x":106,
		"y":189,
		"z":"2317117.fdce8ee",
		"wires":[
			["8a2b638a.75d4a"]
		]
	},
	{
		"id":"8a2b638a.75d4a",
		"type":"flow-reader",
		"name":"",
		"protocol":"http",
		"url":"127.0.0.1:1880",
		"sheet":"Sheet 1",
		"auth":false,
		"x":263,
		"y":189,
		"z":"2317117.fdce8ee",
		"wires":[
			["5791f81d.a86e08"]
		]
	},
	{
		"id":"5791f81d.a86e08",
		"type":"flow-writer",
		"name":"",
		"protocol":"http",
		"url":"192.168.0.1:1880",
		"auth":false,
		"x":433,
		"y":189,
		"z":"2317117.fdce8ee",
		"wires":[
			["2c975cfd.d368a4"]
		]
	},
	{
		"id":"3d3453b3.c2cbac",
		"type":"debug",
		"name":"",
		"active":true,
		"console":"false",
		"complete":"false",
		"x":617,
		"y":262,
		"z":"2317117.fdce8ee",
		"wires":[]
	}
]```

## History
- 0.0.1 - October 2015 : Initial Release

## Authors
* Neo Lo (https://github.com/neo7206)

## License
Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
