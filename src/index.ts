import util from 'util';
import { exec } from "child_process";
const execAsync = util.promisify(exec);
import {
  API,
  Logger,
  AccessoryConfig,
  PlatformAccessory,
  Service as HBService,
} from "homebridge";
import wakeonlan from "wol";

let Service: typeof HBService;
let Characteristic;

const PLUGIN_NAME = "homebridge-philips-tv-adb";
const PLATFORM_NAME = "PhilipsTVADB";
const RETRY_LIMIT = 5;
const DEFAULT_INTERVAL = 5000;
const DEFAULT_NAME = "Android Television";

enum DeviceState {
  OFF,
  ON,
}
enum InputSourceKeys {
  KEYCODE_F1 = 1,
  KEYCODE_F2,
  KEYCODE_F3,
  KEYCODE_F4,
  KEYCODE_F5,
  KEYCODE_F6,
}
interface Source {
  readonly id: number;
  readonly name: string;
  readonly inputSourceKey: InputSourceKeys;
  readonly service: any;
}
interface Apps {
  id: string;
  name: string;
}

interface Config extends AccessoryConfig {
  interval: number;
  ip: string;
  mac: string;
  sources: Source[];
  apps: Apps[];
}

class ADBPlugin {
  private readonly name!: string;
  private readonly interval!: number;
  private readonly ip!: string;
  private readonly mac!: string;
  private readonly sources!: Source[];
  private readonly apps!: Apps[];
  private readonly tv!: PlatformAccessory;
  private readonly tvService: any;
  private readonly tvInfo: any;
  private readonly clearIntervalHandler!: NodeJS.Timeout;

  private retryCounter!: number;

  constructor(
    private readonly log: Logger,
    private readonly config: Config,
    private readonly api: API
  ) {
    this.log.debug("Loaded the following config:\n", config);

    // Configuration
    this.name = this.config.name || DEFAULT_NAME;
    this.interval = this.config.interval || DEFAULT_INTERVAL;
    this.ip = this.config.ip;
    this.mac = this.config.mac;
    this.sources = this.config.sources || [];
    this.apps = this.config.apps || [];
    this.retryCounter = 1;
    this.tvService = api.hap.Service

    if (!config) {
      this.log.error(
        `Please provide a config for this accessory: ${this.config.name}`
      );
      return;
    }

    if (!this.ip) {
      this.log.info(`Please provide IP for this accessory: ${this.name}`);
      return;
    }
    // Interval
    // Can't be lower than 300 miliseconds, it will flood your network
    if (this.interval < 300) {
      this.log.warn(
        this.ip,
        `- setting interval to "300".
        Lower than 300 will flood your network.
        Your current config.json has a interval of "${this.config.interval}".
        Please change it to a value above "300"`
      );
      this.interval = 300;
    }
    // Inputs
    this.log.debug(this.ip, "SOURCES:", this.sources);
    this.log.debug(this.ip, "APPS:", this.apps);

    /**
     * Create the accessory
     */

    // generate a UUID
    const uuid = this.api.hap.uuid.generate(
      "homebridge:adb-plugin" + this.ip + this.name
    );

    // create the external accessory
    this.tv = new this.api.platformAccessory(this.name, uuid);

    // set the external accessory category
    this.tv.category = this.api.hap.Categories.TELEVISION;

    // add the tv service
    this.tvService = this.tv.addService(Service.Television);

    // get the tv information
    this.tvInfo = this.tv.getService(Service.AccessoryInformation);

    // set tv service name
    this.tvService
      .setCharacteristic(Characteristic.ConfiguredName, this.name)
      .setCharacteristic(
        Characteristic.SleepDiscoveryMode,
        Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
      );
      
    // initialize the TV connection
    this.initialize(this.ip);
    // Create sources based of the config
    this.createSources();
    
    // Handle input changes
    this.handleOnOff();
    this.handleSourceChange();
    
    // Check the status every n-seconds
    this.checkStatus(this.interval)
  }

  private async initialize(ip: string) {
    // first check if the device appears in the adb devices
    const deviceList = await this.sendCommand('adb devices')
    if (deviceList.includes(ip)) { 
      // try to adb connect to the device
      const connect = await this.sendCommand(`adb connect ${ip}`)
      if (connect.includes('connected')) {
        // get product information
        const productInfo = await this.sendCommand(`adb -s ${ip} shell "getprop ro.product.model && getprop ro.product.manufacturer && getprop ro.serialno"`)
        const [modelName, manufacturer, serialNumber ] = productInfo.split("\n");

        // regiser the product information to the service
        this.tvInfo
          .setCharacteristic(Characteristic.Model, modelName)
          .setCharacteristic(Characteristic.Manufacturer, manufacturer)
          .setCharacteristic(
            Characteristic.SerialNumber,
            serialNumber || ip
          );

        // Publish the accessories
        this.api.publishExternalAccessories(PLUGIN_NAME, [this.tv]);
      }
    }
  }

  private createSources() {
    this.log.debug(this.ip, this.createSources, "executing");
    this.sources.forEach((source) => {
      this.log.info(this.ip, this.createSources, "creating source:\n", source);
      const service = this.tv.addService(
        Service.InputSource,
        source.name,
        source.id
      );
      service
        .setCharacteristic(Characteristic.Identifier, source.id)
        .setCharacteristic(Characteristic.ConfiguredName, source.name)
        .setCharacteristic(
          Characteristic.InputSourceType,
          Characteristic.InputSourceType.TV
        )
        .setCharacteristic(
          Characteristic.TargetVisibilityState,
          Characteristic.TargetVisibilityState.SHOWN
        )
        .setCharacteristic(
          Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN
        )
        .setCharacteristic(
          Characteristic.IsConfigured,
          Characteristic.IsConfigured.CONFIGURED
        );
      this.tvService.addLinkedService(service);
    });
  }

  private handleOnOff() {
    this.tvService
      .getCharacteristic(Characteristic.Active)
      .on("set", async (newState) => {

        if (newState === DeviceState.ON) {
          this.log.info(
            this.ip,
            this.handleOnOff,
            "power on button is pressed"
          );
          // wake on lan first
          const wokenUp = await this.wakeOnLan(this.mac);

          if (wokenUp) {
            this.log.info(this.ip, this.handleOnOff, "wakeonlan succesfull!");
            // wake the device via adb after WoL
            await this.sendCommand(`adb -s ${this.ip} shell "input keyevent KEYCODE_WAKEUP"`)

            this.tvService.updateCharacteristic(
              Characteristic.Active,
              DeviceState.ON
            );
          }
        }

        if (newState === DeviceState.OFF) {
          this.log.info(
            this.ip,
            this.handleOnOff,
            "power off button is pressed"
          );
          // Put the tv in sleep mode
          await this.sendCommand(`adb -s ${this.ip} shell "input keyevent KEYCODE_SLEEP"`)

          this.tvService.updateCharacteristic(
            Characteristic.Active,
            DeviceState.OFF
          );
        }
      });
  }

  private handleSourceChange() {
    this.tvService
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .on("set", async (state) => {
        const source = this.sources.find((source) => source.id === state);
        // throw an error if the source can't be found
        if (!source) {
          this.log.error(
            this.ip,
            this.handleSourceChange,
            `couldn't find a source with id "${state}"`
          );
        } else {
          // first get the device out of sleep
          await this.sendCommand(`adb -s ${this.ip} shell "input keyevent KEYCODE_WAKEUP"`)
          // execute the command to change the input on the device
          await this.sendCommand(`adb -s ${this.ip} shell "input keyevent ${
            InputSourceKeys[source.inputSourceKey]
          }"`)
        }
      });
  }

  private checkStatus(interval: number) {
    // Update TV status every second -> or based on configuration
    setInterval(async () => {
      this.log.debug(
        this.ip,
        this.checkStatus,
        `checking TV status every ${interval / 1000} seconds`
      );

      // const deviceOn = await this.checkPower();
      const deviceOn = await this.getPowerState(this.ip);

      this.log.warn("PING", deviceOn, typeof deviceOn)
      if (deviceOn) {
        // update tvService characteristics
        this.tvService.updateCharacteristic(
          Characteristic.Active,
          DeviceState.ON
           );
        } else {
        // update tvService characteristics
        this.tvService.updateCharacteristic(
          Characteristic.Active,
          DeviceState.OFF
        );
      }

      if (this.retryCounter >= RETRY_LIMIT) {
        this.log.info(
          this.ip,
          this.checkStatus,
          `Tried to connect to the accesssory for ${this.retryCounter} times. Updating will stop.`
        );
        clearInterval(this.clearIntervalHandler);
      }
    }, interval);
  }
  
  private async wakeOnLan(mac: string): Promise<boolean> {
    try {
      this.log.debug(this.ip, this.wakeOnLan, mac)
      return await wakeonlan.wake(this.mac);
    } catch (error) {
      this.log.error(this.ip, this.wakeOnLan, error)
      throw new Error(error)
    }
  }
  
  private async getPowerState(ip: string): Promise<boolean> {
    const POWER_STATE_CMD = "dumpsys power | grep mHoldingDisplay | cut -d = -f 2"

    try {
      const {stdout: deviceOn, stderr} = await execAsync(`adb -s ${ip} shell "${POWER_STATE_CMD}"`)
      if (stderr) {
        this.log.error(ip, this.getPowerState, "couldn't get power state", stderr)
        throw new Error(stderr)
      } else {
        this.log.info(ip, this.getPowerState, "device power state is:", deviceOn);
        return deviceOn.trim() === "true";
      }
    } catch (error) {
      this.log.error(ip, this.getPowerState, error)
      throw new Error(error)
    }
  }

  private async sendCommand(cmd: string): Promise<string> {
    try {
      this.log.debug(this.ip, this.sendCommand, cmd)
      const {stdout} = await execAsync(cmd);
      return stdout
    } catch (err) {
      this.log.error(this.ip, this.sendCommand, err)
      throw new Error(err)
    }
  }
}

class ADBPluginPlatform {
  log: any;
  api: any;
  config: any;
  constructor(log, config, api) {
    if (!config) {
      return;
    }

    this.log = log;
    this.api = api;
    this.config = config;

    if (this.api) {
      this.api.on("didFinishLaunching", this.initAccessory.bind(this));
    }
  }

  initAccessory() {
    // read from config.accessories
    if (this.config.accessories && Array.isArray(this.config.accessories)) {
      for (const accessory of this.config.accessories) {
        if (accessory) {
          // const tvPlugin = new ADBPlugin(this.log, accessory, this.api);
          new ADBPlugin(this.log, accessory, this.api);
          // tvPlugin.
        }
      }
    } else if (this.config.accessories) {
      this.log.info(
        "Cannot initialize. Type: %s",
        typeof this.config.accessories
      );
    }

    if (!this.config.accessories) {
      this.log.info("-------------------------------------------------");
      this.log.info("Please add one or more accessories in your config");
      this.log.info("------------------------------------------------");
    }
  }
}

module.exports = (homebridge: API) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ADBPluginPlatform);
};
