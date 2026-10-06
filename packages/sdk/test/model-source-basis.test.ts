import { expect,test } from "bun:test";
import { OpenGeniClient } from "../src/index";
import { ModelCallSourceBasisResponse } from "@opengeni/contracts";
test("public SDK reads exactly one encoded call identity without write or latest fallback",async()=>{
 const requests:Request[]=[];const response=ModelCallSourceBasisResponse.parse({schema:"cendra.native-source-basis/v1",receipt:null});
 const client=new OpenGeniClient({baseUrl:"https://api.example.test",apiKey:"synthetic",fetch:(async(url,init)=>{requests.push(new Request(url,init));return Response.json(response);}) as typeof fetch});
 expect(await client.getSessionModelSourceBasis("workspace","session","source:/+ next")).toEqual(response);expect(requests).toHaveLength(1);expect(requests[0]!.method).toBe("GET");expect(new URL(requests[0]!.url).searchParams.get("sourceKey")).toBe("source:/+ next");expect(requests[0]!.body).toBeNull();
});
