from zeep import Client
from zeep.transports import Transport
from requests import Session
from requests.auth import HTTPBasicAuth

# ------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------
SECURITY_WSDL = "http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl/SecurityProvider?wsdl"
EXECUTOR_WSDL = "http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl/ComponentExecutor?wsdl"

USERNAME = "ZZZ"
PASSWORD = ""
BUSINESS_UNIT = "PK1"

# ------------------------------------------------------------------
# SESSION (optional but recommended)
# ------------------------------------------------------------------
session = Session()
session.auth = HTTPBasicAuth(USERNAME, PASSWORD)
transport = Transport(session=session)

# ------------------------------------------------------------------
# CLIENTS
# ------------------------------------------------------------------
security_client = Client(wsdl=SECURITY_WSDL, transport=transport)
executor_client = Client(wsdl=EXECUTOR_WSDL, transport=transport)

# ------------------------------------------------------------------
# AUTHENTICATE
# ------------------------------------------------------------------
token = security_client.service.Authenticate(
  USERNAME,PASSWORD
)

print("Token:", token)

# ------------------------------------------------------------------
# PURCHASE ORDER XML PAYLOAD
# ------------------------------------------------------------------
payload = f"""
<SSC>
  <User>
    <Name>{USERNAME}</Name>
  </User>

  <SunSystemsContext>
    <BusinessUnit>{BUSINESS_UNIT}</BusinessUnit>
  </SunSystemsContext>

 <Payload><PurchaseOrder><Comment>Purchase of servers</Comment><InvoiceAddressCode>0000000000</InvoiceAddressCode><PurchaseTransactionType>PFA</PurchaseTransactionType><PurchaseOrderReference>imp-00025</PurchaseOrderReference><SecondReference></SecondReference><SupplierCode>81105</SupplierCode><PurchaseOrderLine><AccountCode>81105</AccountCode><CurrencyCode>USD</CurrencyCode><ItemCode>GS4002</ItemCode><LineNumber>1</LineNumber><OrderDate>07072026</OrderDate><UserLineNumber>1</UserLineNumber><AnalysisQuantity><Quantity>1</Quantity></AnalysisQuantity><VLAB7><Base><VPolVlabEntry_Val>1</VPolVlabEntry_Val></Base></VLAB7><VLAB9><Trans><VPolVlabEntry_Val>3000</VPolVlabEntry_Val></Trans></VLAB9></PurchaseOrderLine></PurchaseOrder></Payload>


</SSC>
"""

# ------------------------------------------------------------------
# EXECUTE CREATE PO
# ------------------------------------------------------------------
response = executor_client.service.Execute(
    component="PurchaseOrder",
    method="CreateOrAmend",
    payload=payload,
    authentication=token
)

print("RESPONSE:")
print(response)